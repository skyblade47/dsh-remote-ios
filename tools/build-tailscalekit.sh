#!/usr/bin/env bash
# 可复现地构建官方 TailscaleKit.xcframework（方案 D，闸门 A）。
#
# 做什么：
#   读 Vendor/TAILSCALEKIT.VERSION 钉死的 commit → 浅克隆 tailscale/libtailscale
#   → swift/make ios-fat（device arm64 + simulator arm64/x86_64）
#   → 拷到 Vendor/TailscaleKit.xcframework 并打印切片取证。
#
# 不持任何密钥；只在 macOS（本机或 CI macos-15）上运行。
#
# 用法：
#   tools/build-tailscalekit.sh            # 正常构建（已存在且 commit 一致则复用）
#   tools/build-tailscalekit.sh --force    # 删缓存与产物重新构建
#
# 注意：上游 pbxproj 写死 IPHONEOS_DEPLOYMENT_TARGET=18.1（6 处 iOS 配置）。
#       闸门 A 已用命令行覆盖实测 Swift 层无 iOS 18 only API 硬依赖（IOS17_OVERRIDE=PASS）。
#       Phase 3.1 起在 checkout 后、make 前用 sed 把 pbxproj 6 处 18.1 批量改成
#       VERSION 的 IOS_DEPLOYMENT_TARGET=17.0，使正式 xcframework 产物的 minos
#       就是本工程的 17.0，消除链接 warning。
#       【run 40345456800 证伪】export IPHONEOS_DEPLOYMENT_TARGET 环境变量无效：
#       xcodebuild build setting 优先级为「命令行 > pbxproj 工程值 > 环境变量」，
#       pbxproj 的显式 18.1 压制环境变量（vtool 仍见 minos 18.1）；上游 Makefile
#       钉死在 libtailscale 仓内、命令行不可注入，故只能构建期 patch pbxproj。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="${REPO_ROOT}/Vendor/TAILSCALEKIT.VERSION"
OUT_FRAMEWORK="${REPO_ROOT}/Vendor/TailscaleKit.xcframework"
SRC_DIR="${REPO_ROOT}/.tailscalekit-src"

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: 只能在 macOS 构建（需要 Xcode/iOS SDK），当前：$(uname -s)" >&2
  exit 1
fi
if [ ! -f "${VERSION_FILE}" ]; then
  echo "ERROR: 找不到版本真源 ${VERSION_FILE}" >&2
  exit 1
fi

# 读版本真源（KEY=VALUE，忽略注释/空行；值不含引号）
# shellcheck disable=SC1090
while IFS='=' read -r key value; do
  case "${key}" in ''|\#*) continue;; esac
  eval "CONF_${key}=\"\${value}\""
done < <(grep -v '^[[:space:]]*#' "${VERSION_FILE}" | grep -v '^[[:space:]]*$')

: "${CONF_LIBTAILSCALE_REPO:?VERSION 缺 LIBTAILSCALE_REPO}"
: "${CONF_LIBTAILSCALE_COMMIT:?VERSION 缺 LIBTAILSCALE_COMMIT}"
: "${CONF_GO_VERSION:?VERSION 缺 GO_VERSION}"
: "${CONF_BUILD_COMMAND:?VERSION 缺 BUILD_COMMAND}"
: "${CONF_BUILD_ARTIFACT:?VERSION 缺 BUILD_ARTIFACT}"

echo "== 版本真源 =="
echo "  repo    : ${CONF_LIBTAILSCALE_REPO}"
echo "  commit  : ${CONF_LIBTAILSCALE_COMMIT}"
echo "  binding : ${CONF_LIBTAILSCALE_BINDING_VERSION:-?}"
echo "  tailnet : ${CONF_TAILSCALE_VERSION:-?}"
echo "  go      : ${CONF_GO_VERSION}"

# 已有产物且 commit 一致：默认复用（幂等）
STAMP_FILE="${OUT_FRAMEWORK}/.built-from"
if [ "${FORCE}" -eq 0 ] && [ -f "${STAMP_FILE}" ] && [ -d "${OUT_FRAMEWORK}" ]; then
  if grep -q "${CONF_LIBTAILSCALE_COMMIT}" "${STAMP_FILE}" 2>/dev/null; then
    echo "== Vendor/TailscaleKit.xcframework 已存在且 commit 一致，复用（--force 可重建） =="
  else
    echo "== 现存产物来自不同 commit，重建 =="
    FORCE=1
  fi
fi

if [ "${FORCE}" -eq 1 ]; then
  rm -rf "${SRC_DIR}" "${OUT_FRAMEWORK}"
fi

# --- 取代码（浅克隆指定 commit） ---
if [ ! -d "${SRC_DIR}/.git" ]; then
  echo "== 浅克隆 libtailscale =="
  mkdir -p "$(dirname "${SRC_DIR}")"
  git init -q "${SRC_DIR}"
  git -C "${SRC_DIR}" remote add origin "${CONF_LIBTAILSCALE_REPO}"
  git -C "${SRC_DIR}" fetch -q --depth 1 origin "${CONF_LIBTAILSCALE_COMMIT}"
  git -C "${SRC_DIR}" checkout -q FETCH_HEAD
else
  echo "== 复用源码缓存 ${SRC_DIR} =="
fi
GOT_COMMIT="$(git -C "${SRC_DIR}" rev-parse HEAD)"
if [ "${GOT_COMMIT}" != "${CONF_LIBTAILSCALE_COMMIT}" ]; then
  echo "ERROR: 缓存源码 commit ${GOT_COMMIT} != 期望 ${CONF_LIBTAILSCALE_COMMIT}（用 --force）" >&2
  exit 1
fi

# --- 工具链核对 ---
echo "== 工具链 =="
xcodebuild -version | sed 's/^/  /'
if command -v go >/dev/null 2>&1; then
  echo "  go present: $(go version)"
else
  echo "  WARNING: PATH 中无 go。CI 由 setup-go 提供；本机若未装 Go 会在下一步失败。" >&2
fi

# --- 构建 ---
# 覆盖上游写死的 18.1（见文件头注释）。run 40345456800 实测：**export
# IPHONEOS_DEPLOYMENT_TARGET 环境变量无效**——xcodebuild 的 build setting
# 优先级是「命令行 > pbxproj 工程值 > 环境变量」，上游 Makefile 未在命令行设该项，
# 环境变量被 pbxproj 的显式 18.1 压制（vtool 仍见 minos 18.1）。
# 上游 Makefile 又钉死在 libtailscale 仓内、命令行不可注入，故唯一不改上游命令
# 的做法是构建前直接 patch pbxproj。Go c-archive（libtailscale_ios*.a）由
# clangwrap-ios*.sh 以 -mios-version-min=12.0 编译（minos 12.0），不冲突。
: "${CONF_IOS_DEPLOYMENT_TARGET:?VERSION 缺 IOS_DEPLOYMENT_TARGET}"
PBXPROJ="${SRC_DIR}/swift/TailscaleKit.xcodeproj/project.pbxproj"
echo "== patch pbxproj：IPHONEOS_DEPLOYMENT_TARGET 18.1 -> ${CONF_IOS_DEPLOYMENT_TARGET} =="
BEFORE=$(grep -c 'IPHONEOS_DEPLOYMENT_TARGET = 18.1' "${PBXPROJ}")
# macOS 自带 BSD sed，用 -i ''；只动 iOS 一项，MACOSX/XROS 部署目标不碰。
sed -i '' "s/IPHONEOS_DEPLOYMENT_TARGET = 18\.1;/IPHONEOS_DEPLOYMENT_TARGET = ${CONF_IOS_DEPLOYMENT_TARGET};/g" "${PBXPROJ}"
AFTER=$(grep -c "IPHONEOS_DEPLOYMENT_TARGET = ${CONF_IOS_DEPLOYMENT_TARGET}" "${PBXPROJ}")
echo "  替换前 18.1 行数=${BEFORE}，替换后 ${CONF_IOS_DEPLOYMENT_TARGET} 行数=${AFTER}"
if [ "${BEFORE}" -eq 0 ] || [ "${AFTER}" -lt "${BEFORE}" ]; then
  echo "ERROR: pbxproj patch 未命中（上游是否改了部署目标写法？）" >&2
  grep -n 'IPHONEOS_DEPLOYMENT_TARGET' "${PBXPROJ}" >&2 || true
  exit 1
fi
echo "== ${CONF_BUILD_COMMAND} =="
( cd "${SRC_DIR}" && eval "${CONF_BUILD_COMMAND}" )

BUILT="${SRC_DIR}/${CONF_BUILD_ARTIFACT}"
if [ ! -d "${BUILT}" ]; then
  echo "ERROR: 构建产物不存在：${BUILT}" >&2
  exit 1
fi

# --- 落 Vendor ---
mkdir -p "$(dirname "${OUT_FRAMEWORK}")"
rm -rf "${OUT_FRAMEWORK}"
cp -R "${BUILT}" "${OUT_FRAMEWORK}"
{
  echo "commit=${CONF_LIBTAILSCALE_COMMIT}"
  echo "binding=${CONF_LIBTAILSCALE_BINDING_VERSION:-unknown}"
  echo "tailscale=${CONF_TAILSCALE_VERSION:-unknown}"
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "xcode=$(xcodebuild -version | tr '\n' ' ' | sed 's/ $//')"
} > "${STAMP_FILE}"

echo "== 切片取证 =="
for fw in "${OUT_FRAMEWORK}"/ios-*/TailscaleKit.framework; do
  [ -d "${fw}" ] || continue
  bin="${fw}/TailscaleKit"
  echo "  --- ${fw} ---"
  lipo -info "${bin}" 2>/dev/null | sed 's/^/    /'
  # 该二进制编译时的最低 iOS 版本（必须为 pbxproj patch 后的 17.0）
  vtool -show-build "${bin}" 2>/dev/null | grep -E 'platform|minos' | sed 's/^/    /' || true
done

echo "== 完成：${OUT_FRAMEWORK} =="
