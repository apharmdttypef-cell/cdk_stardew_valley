#!/bin/bash
# =============================================================================
# stardew-backup.sh — セーブデータのみを S3 へ sync する。
# stardew-backup.service (oneshot) / timer / Backup Lambda(SSM) から実行される。
# ゲーム本体・MOD バイナリは対象外（セーブのみ）。
# =============================================================================
set -euxo pipefail
source /etc/stardew.env

# セーブデータパス（§6.4 で実機確認）。SMAPI/Linux 標準は ~/.config/StardewValley/Saves。
SAVE_DIR="${MOUNT_POINT}/home/.config/StardewValley/Saves"

if [ ! -d "$SAVE_DIR" ]; then
  echo "Save dir not found: $SAVE_DIR (まだセーブが無い可能性)。" >&2
  exit 0
fi

aws s3 sync "$SAVE_DIR" "s3://${SAVE_BUCKET}/saves/" \
  --region "$AWS_REGION" --delete

echo "Backup completed: s3://${SAVE_BUCKET}/saves/"
