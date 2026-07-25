#!/bin/bash
# =============================================================================
# stardew-install.sh — SteamCMD / Stardew 本体 / SMAPI / MOD の冪等インストール。
# stardew-install.service (oneshot) から実行される。
# EBS 永続化のため通常は初回のみ本処理が走る。
# =============================================================================
set -euxo pipefail
source /etc/stardew.env

STEAMCMD_DIR="${MOUNT_POINT}/steamcmd"
GAME_DIR="${MOUNT_POINT}/game"
STARDEW_APPID=413150   # Stardew Valley Steam AppID

mkdir -p "$STEAMCMD_DIR" "$GAME_DIR"

# --- SteamCMD 取得 -----------------------------------------------------------
if [ ! -x "${STEAMCMD_DIR}/steamcmd.sh" ]; then
  curl -sL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" \
    | tar -xz -C "$STEAMCMD_DIR"
fi

# --- Steam 認証情報の取得（Secrets Manager） --------------------------------
# TODO(design §6.1): Steam Guard / 2FA のヘッドレス対応。
#   ここでは Secrets Manager からユーザー名/パスワード(/shared_secret) を取得する想定。
#   shared_secret がある場合は steamguard-cli 等で TOTP を生成して渡す。
CREDS=$(aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id stardew/steam --query SecretString --output text 2>/dev/null || echo '{}')
STEAM_USER=$(jq -r '.username // empty' <<<"$CREDS")
STEAM_PASS=$(jq -r '.password // empty' <<<"$CREDS")

if [ -z "$STEAM_USER" ]; then
  echo "ERROR: Steam credentials not found in Secrets Manager (stardew/steam)." >&2
  echo "       §6.1 の設計判断が未確定です。" >&2
  exit 1
fi

# --- Stardew 本体インストール / 更新 ----------------------------------------
if [ ! -f "${GAME_DIR}/Stardew Valley.dll" ] && [ ! -f "${GAME_DIR}/StardewValley" ]; then
  "${STEAMCMD_DIR}/steamcmd.sh" \
    +force_install_dir "$GAME_DIR" \
    +login "$STEAM_USER" "$STEAM_PASS" \
    +app_update "$STARDEW_APPID" validate \
    +quit
fi

# --- SMAPI 導入 --------------------------------------------------------------
# TODO(design §6.2/§6.3): SMAPI の最新版取得先とインストーラの非対話実行、
#   ARM64 での Mono/.NET 動作可否を実機で確定する。
if [ ! -d "${GAME_DIR}/smapi-internal" ]; then
  echo "SMAPI 未導入。インストーラをここで実行する（要実機確定）。" >&2
  # 例（擬似）:
  #   curl -sL <SMAPI release zip> -o /tmp/smapi.zip
  #   unzip /tmp/smapi.zip -d /tmp/smapi
  #   (cd /tmp/smapi && ./install.sh --install --game-path "$GAME_DIR")
fi

# --- Dedicated Server 系 MOD 導入 -------------------------------------------
# TODO(design §6.3): MOD の入手（Nexus は認証が必要な場合あり）と配置先
#   (${GAME_DIR}/Mods/) を確定する。
mkdir -p "${GAME_DIR}/Mods"

echo "stardew-install.sh done."
