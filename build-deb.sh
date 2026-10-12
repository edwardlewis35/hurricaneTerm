#!/usr/bin/env bash
# hurricaneTerm 构建环境（rootless：-dev 包解在 ~/opt/wt-sysroot，Rust 在 ~/.cargo）
SR=$HOME/opt/wt-sysroot
export PATH=$SR/usr/bin:$HOME/.cargo/bin:$PATH
export PKG_CONFIG_PATH=$SR/usr/lib/x86_64-linux-gnu/pkgconfig:$SR/usr/share/pkgconfig
export LIBRARY_PATH=$SR/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH=$SR/usr/lib/x86_64-linux-gnu
export LD_LIBRARY_PATH=$SR/usr/lib/x86_64-linux-gnu
cd "$(dirname "$0")"
npm run prepare-dist
npx tauri build --bundles deb
