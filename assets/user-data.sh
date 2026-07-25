#!/bin/bash
# =============================================================================
# Stardew Valley Dedicated Server — EC2 user-data (Amazon Linux 2023)
#
# 起動時の処理フロー:
#   1. データ EBS ボリュームをアタッチ・マウント (/mnt/stardew)
#   2. 依存パッケージ導入 (SteamCMD 実行に必要な 32bit ライブラリ等)
#   3. SteamCMD で Stardew Valley 本体を導入（未導入時のみ）
#   4. SMAPI + Dedicated Server 系 MOD を導入（未導入時のみ）
#   5. Route53 の A レコードを現在のパブリック IP で UPSERT
#   6. ゲームサーバー (SMAPI ヘッドレス) を systemd で起動
#
# プレースホルダは CDK (compute-stack.ts) が実値に置換する:
#   __DATA_VOLUME_ID__ __SAVE_BUCKET__ __HOSTED_ZONE_ID__
#   __RECORD_NAME__ __AWS_REGION__ __GAME_PORT__
#
# ⚠️ 未確定事項（requirements.md §6）は TODO(design) として明示。
# =============================================================================
set -euxo pipefail

DATA_VOLUME_ID="__DATA_VOLUME_ID__"
SAVE_BUCKET="__SAVE_BUCKET__"
HOSTED_ZONE_ID="__HOSTED_ZONE_ID__"
RECORD_NAME="__RECORD_NAME__"
AWS_REGION="__AWS_REGION__"
GAME_PORT="__GAME_PORT__"
ASSETS_BUCKET="__ASSETS_BUCKET__"
ASSETS_KEY="__ASSETS_KEY__"

MOUNT_POINT="/mnt/stardew"
STARDEW_USER="stardew"

# --- 0. 共通ツール -----------------------------------------------------------
dnf install -y awscli jq tar unzip

# --- 1. EBS アタッチ & マウント ---------------------------------------------
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)

# 既にアタッチ済みでなければアタッチ（/dev/sdf を要求）
aws ec2 attach-volume --region "$AWS_REGION" \
  --volume-id "$DATA_VOLUME_ID" \
  --instance-id "$INSTANCE_ID" \
  --device /dev/sdf || true

# デバイスが現れるまで待機（NVMe では名前が変わるため by-id で探す）
for i in $(seq 1 30); do
  DEV=$(lsblk -o NAME,SERIAL -dn | awk -v v="${DATA_VOLUME_ID/vol-/vol}" \
    '$2 ~ v {print "/dev/"$1}')
  [ -n "${DEV:-}" ] && break
  # フォールバック: 伝統的デバイス名
  [ -b /dev/sdf ] && DEV=/dev/sdf && break
  [ -b /dev/xvdf ] && DEV=/dev/xvdf && break
  sleep 2
done
echo "Data device: ${DEV:?EBS device not found}"

# 初回のみファイルシステム作成（既存データがある場合は絶対に mkfs しない）
if ! blkid "$DEV"; then
  mkfs -t xfs "$DEV"
fi
mkdir -p "$MOUNT_POINT"
mount "$DEV" "$MOUNT_POINT"

# --- 2. 実行ユーザー ---------------------------------------------------------
id -u "$STARDEW_USER" &>/dev/null || useradd -m -d "$MOUNT_POINT/home" "$STARDEW_USER"
mkdir -p "$MOUNT_POINT/home" "$MOUNT_POINT/game" "$MOUNT_POINT/steamcmd"
chown -R "$STARDEW_USER":"$STARDEW_USER" "$MOUNT_POINT"

# --- 3. SteamCMD / Stardew 本体 ---------------------------------------------
# TODO(design §6.1): Steam ライセンス認証（Steam Guard/2FA）。
#   クレデンシャルは Secrets Manager から取得する想定。user-data に平文で置かない。
#   例:
#     CREDS=$(aws secretsmanager get-secret-value --region "$AWS_REGION" \
#             --secret-id stardew/steam --query SecretString --output text)
#     STEAM_USER=$(jq -r .username <<<"$CREDS")
#     STEAM_PASS=$(jq -r .password <<<"$CREDS")
#     STEAM_GUARD=$(steamguard-cli ...)  # shared_secret から TOTP を生成
#
# TODO(design §6.2): ARM64(t4g) で SMAPI(Mono/.NET) が動作しない場合は
#   x86_64(t3.small) へ切替（config.ts の architecture を変更）。
#
# 本体導入は systemd oneshot (stardew-install.service) に委譲する。

# --- 5. Route53 DNS UPSERT ---------------------------------------------------
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/public-ipv4)

cat >/tmp/route53-change.json <<JSON
{
  "Comment": "Stardew server IP update",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${RECORD_NAME}",
      "Type": "A",
      "TTL": 60,
      "ResourceRecords": [{ "Value": "${PUBLIC_IP}" }]
    }
  }]
}
JSON

aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch file:///tmp/route53-change.json

# --- 6. スクリプト / systemd unit の配置（S3 アセットから取得） -------------
BUNDLE_DIR="$(mktemp -d)"
aws s3 cp "s3://${ASSETS_BUCKET}/${ASSETS_KEY}" "${BUNDLE_DIR}/bundle.zip" \
  --region "$AWS_REGION"
unzip -o "${BUNDLE_DIR}/bundle.zip" -d "$BUNDLE_DIR"

install -m 0755 "${BUNDLE_DIR}/scripts/stardew-install.sh" /usr/local/bin/stardew-install.sh
install -m 0755 "${BUNDLE_DIR}/scripts/stardew-server.sh"  /usr/local/bin/stardew-server.sh
install -m 0755 "${BUNDLE_DIR}/scripts/stardew-backup.sh"  /usr/local/bin/stardew-backup.sh
install -m 0644 "${BUNDLE_DIR}"/systemd/stardew-*.service /etc/systemd/system/
install -m 0644 "${BUNDLE_DIR}"/systemd/stardew-*.timer   /etc/systemd/system/

# --- 7. 環境ファイル & systemd 有効化 ---------------------------------------
cat >/etc/stardew.env <<ENV
MOUNT_POINT=${MOUNT_POINT}
STARDEW_USER=${STARDEW_USER}
SAVE_BUCKET=${SAVE_BUCKET}
AWS_REGION=${AWS_REGION}
GAME_PORT=${GAME_PORT}
ENV

systemctl daemon-reload
systemctl enable --now stardew-install.service
systemctl enable --now stardew-server.service
systemctl enable --now stardew-backup.timer

echo "user-data completed."
