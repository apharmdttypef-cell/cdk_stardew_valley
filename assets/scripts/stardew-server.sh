#!/bin/bash
# =============================================================================
# stardew-server.sh — SMAPI をヘッドレスで起動する。
# stardew-server.service (simple, Restart=on-failure) から実行される。
# =============================================================================
set -euxo pipefail
source /etc/stardew.env

GAME_DIR="${MOUNT_POINT}/game"
cd "$GAME_DIR"

# SMAPI/MOD がセーブを参照するパスを HOME に固定（§6.4）。
export HOME="${MOUNT_POINT}/home"

# TODO(design §6.3): Dedicated Server 系 MOD の起動要件に合わせて調整。
#   - GUI/表示依存がある場合は xvfb-run でラップ:
#       exec xvfb-run -a ./StardewModdingAPI --no-terminal
#   - ヘッドレス専用ビルドの場合はそのまま起動。
exec ./StardewModdingAPI --no-terminal
