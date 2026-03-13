#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
# Harmonia Release Script
#
# Usage:
#   npm run release              # 完整流程
#   npm run release -- --from 8  # 从第 8 步（publish）开始
#
# Steps:
#   1. 检查 Git 工作区
#   2. 检查分支
#   3. 选择版本号
#   4. 格式化代码
#   5. 回归测试
#   6. 构建
#   7. 版本号写入 + commit + tag
#   8. npm publish
#   9. git push
#  10. 同步分支
# ─────────────────────────────────────────────

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Parse --from argument
START_FROM=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)
            START_FROM="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: npm run release [-- --from <step>]"
            echo ""
            echo "Steps:"
            echo "  1  检查 Git 工作区"
            echo "  2  检查分支"
            echo "  3  选择版本号"
            echo "  4  格式化代码"
            echo "  5  回归测试"
            echo "  6  构建"
            echo "  7  版本号写入 + commit + tag"
            echo "  8  npm publish"
            echo "  9  git push"
            echo "  10 同步分支"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Step counter
STEP=0
TOTAL_STEPS=10

step() {
    STEP=$((STEP + 1))
    if [ "$STEP" -lt "$START_FROM" ]; then
        return 1  # skip
    fi
    echo ""
    echo -e "${BLUE}${BOLD}[$STEP/$TOTAL_STEPS]${RESET} ${BOLD}$1${RESET}"
    echo -e "${DIM}────────────────────────────────────────${RESET}"
    return 0
}

success() {
    echo -e "  ${GREEN}✓${RESET} $1"
}

warn() {
    echo -e "  ${YELLOW}⚠${RESET} $1"
}

fail() {
    echo -e "  ${RED}✗${RESET} $1"
    exit 1
}

confirm() {
    echo ""
    read -r -p "  $1 [y/N] " answer
    case "$answer" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) echo ""; echo -e "  ${DIM}已取消${RESET}"; exit 0 ;;
    esac
}

# ─────────────────────────────────────────────
# Header
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}Harmonia Release${RESET}"
echo -e "${DIM}────────────────────────────────────────${RESET}"

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "  当前版本: ${BOLD}v${CURRENT_VERSION}${RESET}"

if [ "$START_FROM" -gt 1 ]; then
    echo -e "  从第 ${BOLD}${START_FROM}${RESET} 步开始"
fi

# ─────────────────────────────────────────────
# Step 1: Check git status
# ─────────────────────────────────────────────
if step "检查 Git 工作区"; then
    if [ -n "$(git status --porcelain)" ]; then
        fail "工作区不干净，请先提交或暂存所有改动"
    fi
    success "工作区干净"
fi

# ─────────────────────────────────────────────
# Step 2: Check branch
# ─────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if step "检查分支"; then
    echo -e "  当前分支: ${BOLD}${BRANCH}${RESET}"

    if [ "$BRANCH" != "main" ]; then
        warn "当前不在 main 分支，正式发包建议在 main 分支进行"
        confirm "确定要从 ${BRANCH} 分支发包吗？"
    fi
    success "分支确认: ${BRANCH}"
fi

# ─────────────────────────────────────────────
# Step 3: Select version bump
# ─────────────────────────────────────────────
VERSION_TYPE=""

if step "选择版本号"; then
    echo ""
    echo "  请选择版本升级类型:"
    echo ""

    OPTIONS=("patch" "minor" "major" "prepatch" "preminor" "premajor")
    DESCRIPTIONS=(
        "补丁版本 (bug fixes)"
        "次版本号 (new features)"
        "主版本号 (breaking changes)"
        "预发布补丁"
        "预发布次版本"
        "预发布主版本"
    )

    for i in "${!OPTIONS[@]}"; do
        PREVIEW=$(npx --yes semver "$CURRENT_VERSION" -i "${OPTIONS[$i]}" 2>/dev/null || echo "?")
        echo -e "    ${BOLD}$((i + 1)))${RESET} ${OPTIONS[$i]}  ${DIM}→ v${PREVIEW}${RESET}  ${DIM}(${DESCRIPTIONS[$i]})${RESET}"
    done

    echo ""
    while true; do
        read -r -p "  请输入选项 [1-${#OPTIONS[@]}]: " choice
        if [[ "$choice" =~ ^[1-6]$ ]]; then
            VERSION_TYPE="${OPTIONS[$((choice - 1))]}"
            break
        fi
        echo -e "  ${RED}无效选项，请重新输入${RESET}"
    done

    NEW_VERSION=$(npx --yes semver "$CURRENT_VERSION" -i "$VERSION_TYPE" 2>/dev/null)
    echo ""
    success "版本升级: v${CURRENT_VERSION} → v${NEW_VERSION} (${VERSION_TYPE})"

    confirm "确认发布 v${NEW_VERSION}？"
fi

# ─────────────────────────────────────────────
# Step 4: Format
# ─────────────────────────────────────────────
if step "格式化代码"; then
    npm run prettier:fix 2>&1 | tail -1
    success "格式化完成"

    if [ -n "$(git status --porcelain)" ]; then
        fail "格式化产生了未提交的改动，请先提交后重新运行"
    fi
fi

# ─────────────────────────────────────────────
# Step 5: Test
# ─────────────────────────────────────────────
if step "回归测试"; then
    npm test 2>&1 | tail -3
    success "测试通过"
fi

# ─────────────────────────────────────────────
# Step 6: Build
# ─────────────────────────────────────────────
if step "构建"; then
    npm run build 2>&1
    success "构建完成"
fi

# ─────────────────────────────────────────────
# Step 7: Version + commit + tag
# ─────────────────────────────────────────────
if step "版本号写入 + commit + tag"; then
    if [ -z "$VERSION_TYPE" ]; then
        fail "缺少版本类型（跳步时请从第 8 步开始，第 7 步需要版本选择）"
    fi

    echo -e "  ${DIM}npm version ${VERSION_TYPE}...${RESET}"
    npm version "$VERSION_TYPE" --no-git-tag-version > /dev/null 2>&1

    NEW_VERSION=$(node -p "require('./package.json').version")
    git add package.json package-lock.json 2>/dev/null || git add package.json
    git commit -m "release: v${NEW_VERSION}" > /dev/null 2>&1
    git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
    success "版本: v${NEW_VERSION}"
fi

# ─────────────────────────────────────────────
# Step 8: npm publish
# ─────────────────────────────────────────────
if step "npm publish"; then
    PUBLISH_VERSION=$(node -p "require('./package.json').version")
    echo -e "  ${DIM}发布 v${PUBLISH_VERSION}...${RESET}"
    npm publish --access public
    success "npm 发布完成"
fi

# ─────────────────────────────────────────────
# Step 9: git push
# ─────────────────────────────────────────────
if step "git push"; then
    git push && git push --tags
    success "Git 推送完成"
fi

# ─────────────────────────────────────────────
# Step 10: 同步分支
# ─────────────────────────────────────────────
if step "同步分支"; then
    if [ "$BRANCH" = "main" ]; then
        git checkout develop
        git merge main
        git push origin develop
        success "已合并 main → develop，当前在 develop 分支"
    elif [ "$BRANCH" = "develop" ]; then
        git checkout main
        git merge develop
        git push origin main
        git checkout develop
        success "已合并 develop → main，当前在 develop 分支"
    else
        git checkout main
        git merge "$BRANCH"
        git push origin main
        git checkout develop
        git merge "$BRANCH"
        git push origin develop
        success "已合并 ${BRANCH} → main + develop，当前在 develop 分支"
    fi
fi

# ─────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────
FINAL_VERSION=$(node -p "require('./package.json').version")
FINAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo ""
echo -e "${GREEN}${BOLD}发布成功！${RESET}"
echo -e "  版本: ${BOLD}v${FINAL_VERSION}${RESET}"
echo -e "  分支: ${FINAL_BRANCH}"
echo -e "  npm:  https://www.npmjs.com/package/@s_s/harmonia"
echo ""
