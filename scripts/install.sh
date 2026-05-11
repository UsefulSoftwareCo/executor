#!/usr/bin/env bash
set -euo pipefail
APP=executor
REPO=RhysSullivan/executor

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
NC='\033[0m'

usage() {
    cat <<EOF
Executor installer

Usage: install.sh [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g. 1.4.12)
    -b, --binary <path>     Install from a local binary instead of downloading
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)

Examples:
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash
    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash -s -- --version 1.4.12
    ./install.sh --binary /path/to/executor
EOF
}

requested_version=${VERSION:-}
no_modify_path=false
binary_path=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
            if [[ -n "${2:-}" ]]; then
                requested_version="$2"
                shift 2
            else
                echo -e "${RED}Error: --version requires a version argument${NC}" >&2
                exit 1
            fi
            ;;
        -b|--binary)
            if [[ -n "${2:-}" ]]; then
                binary_path="$2"
                shift 2
            else
                echo -e "${RED}Error: --binary requires a path argument${NC}" >&2
                exit 1
            fi
            ;;
        --no-modify-path)
            no_modify_path=true
            shift
            ;;
        *)
            echo -e "${ORANGE}Warning: Unknown option '$1'${NC}" >&2
            shift
            ;;
    esac
done

INSTALL_DIR="${EXECUTOR_INSTALL_DIR:-$HOME/.executor/bin}"
mkdir -p "$INSTALL_DIR"

print_message() {
    local level=$1 message=$2 color=""
    case "$level" in
        info) color="${NC}" ;;
        warning) color="${ORANGE}" ;;
        error) color="${RED}" ;;
    esac
    echo -e "${color}${message}${NC}"
}

if [[ -n "$binary_path" ]]; then
    if [[ ! -f "$binary_path" ]]; then
        print_message error "Error: binary not found at $binary_path"
        exit 1
    fi
    specific_version="local"
else
    raw_os=$(uname -s)
    case "$raw_os" in
        Darwin*) os="darwin" ;;
        Linux*) os="linux" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)
            print_message error "Unsupported OS: $raw_os"
            exit 1
            ;;
    esac

    arch=$(uname -m)
    case "$arch" in
        aarch64|arm64) arch="arm64" ;;
        x86_64|amd64) arch="x64" ;;
        *)
            print_message error "Unsupported architecture: $arch"
            exit 1
            ;;
    esac

    # Apple Silicon under Rosetta reports x64 — install the native arm64 build.
    if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
        if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
            arch="arm64"
        fi
    fi

    is_musl=false
    if [[ "$os" == "linux" ]]; then
        if [[ -f /etc/alpine-release ]]; then
            is_musl=true
        elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
            is_musl=true
        fi
    fi

    target="${os}-${arch}"
    if [[ "$is_musl" == "true" ]]; then
        target="${target}-musl"
    fi

    archive_ext=".zip"
    if [[ "$os" == "linux" ]]; then
        archive_ext=".tar.gz"
    fi

    filename="${APP}-${target}${archive_ext}"

    if [[ "$os" == "linux" ]]; then
        if ! command -v tar >/dev/null 2>&1; then
            print_message error "Error: 'tar' is required but not installed."
            exit 1
        fi
    else
        if ! command -v unzip >/dev/null 2>&1; then
            print_message error "Error: 'unzip' is required but not installed."
            exit 1
        fi
    fi

    if [[ -z "$requested_version" ]]; then
        url="https://github.com/${REPO}/releases/latest/download/${filename}"
        specific_version=$(
            curl -s "https://api.github.com/repos/${REPO}/releases/latest" \
                | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p'
        )
        if [[ -z "$specific_version" ]]; then
            print_message error "Failed to fetch latest version metadata"
            exit 1
        fi
    else
        requested_version="${requested_version#v}"
        url="https://github.com/${REPO}/releases/download/v${requested_version}/${filename}"
        specific_version="$requested_version"

        http_status=$(curl -sI -o /dev/null -w "%{http_code}" \
            "https://github.com/${REPO}/releases/tag/v${requested_version}")
        if [[ "$http_status" == "404" ]]; then
            print_message error "Error: release v${requested_version} not found"
            print_message info "${MUTED}Available releases: https://github.com/${REPO}/releases${NC}"
            exit 1
        fi
    fi
fi

check_existing_version() {
    if command -v executor >/dev/null 2>&1; then
        local installed
        installed=$(executor --version 2>/dev/null || echo "")
        if [[ "$installed" == "$specific_version" ]]; then
            print_message info "${MUTED}Version ${NC}${specific_version}${MUTED} already installed${NC}"
            exit 0
        fi
        print_message info "${MUTED}Replacing installed version ${NC}${installed}"
    fi
}

download_and_install() {
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}version: ${NC}${specific_version}"
    local tmp_dir
    tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/${APP}_install_XXXXXXXXXX")
    trap 'rm -rf "$tmp_dir"' RETURN

    curl -# -L -o "${tmp_dir}/${filename}" "$url"

    if [[ "$os" == "linux" ]]; then
        tar -xzf "${tmp_dir}/${filename}" -C "$tmp_dir"
    else
        unzip -q "${tmp_dir}/${filename}" -d "$tmp_dir"
    fi

    # The archive is flat — the binary plus sidecars (emscripten-module.wasm,
    # keyring.node) sit at the root. Copy them all into INSTALL_DIR so the
    # binary's relative-path lookups still resolve.
    rm -f "${tmp_dir}/${filename}"
    cp -R "${tmp_dir}/." "${INSTALL_DIR}/"

    chmod 755 "${INSTALL_DIR}/${APP}"
    rm -rf "$tmp_dir"
    trap - RETURN
}

install_from_binary() {
    print_message info "\n${MUTED}Installing ${NC}${APP} ${MUTED}from: ${NC}${binary_path}"
    cp "$binary_path" "${INSTALL_DIR}/${APP}"
    chmod 755 "${INSTALL_DIR}/${APP}"
}

if [[ -n "$binary_path" ]]; then
    install_from_binary
else
    check_existing_version
    download_and_install
fi

add_to_path() {
    local config_file=$1 command=$2
    if grep -Fxq "$command" "$config_file"; then
        print_message info "${MUTED}Already in ${NC}${config_file}"
    elif [[ -w "$config_file" ]]; then
        echo -e "\n# executor" >> "$config_file"
        echo "$command" >> "$config_file"
        print_message info "${MUTED}Added ${NC}${APP} ${MUTED}to \$PATH in ${NC}${config_file}"
    else
        print_message warning "Manually add to ${config_file}:"
        print_message info "  $command"
    fi
}

XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
current_shell=$(basename "${SHELL:-bash}")

case "$current_shell" in
    fish)
        config_files="$HOME/.config/fish/config.fish"
        ;;
    zsh)
        config_files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
        ;;
    bash)
        config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
        ;;
    *)
        config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
        ;;
esac

if [[ "$no_modify_path" != "true" ]]; then
    config_file=""
    for file in $config_files; do
        if [[ -f "$file" ]]; then
            config_file=$file
            break
        fi
    done

    if [[ -z "$config_file" ]]; then
        print_message warning "No config file found for ${current_shell}. Add manually:"
        print_message info "  export PATH=${INSTALL_DIR}:\$PATH"
    elif [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        case "$current_shell" in
            fish) add_to_path "$config_file" "fish_add_path $INSTALL_DIR" ;;
            *)    add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH" ;;
        esac
    fi
fi

if [[ -n "${GITHUB_ACTIONS-}" && "${GITHUB_ACTIONS}" == "true" ]]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    print_message info "${MUTED}Added ${NC}${INSTALL_DIR}${MUTED} to \$GITHUB_PATH${NC}"
fi

print_message info ""
print_message info "${MUTED}Installed ${NC}${APP} ${MUTED}to ${NC}${INSTALL_DIR}/${APP}"
print_message info ""
print_message info "${MUTED}Get started:${NC}"
print_message info "  ${APP} web"
print_message info ""
