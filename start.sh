#!/bin/bash
# Claude Mobile UI — startup script
#
# Usage:
#   ./start.sh                   # HTTP mode
#   ./start.sh --https           # HTTPS using certs at default location (~/.certs/claude-mobile/)
#   ./start.sh --https --cert /path/to/cert.pem --key /path/to/key.pem
#   ./start.sh --stop            # Stop everything
#
# One-time HTTPS setup (run once per machine):
#   brew install mkcert
#   mkcert -install
#   mkdir -p ~/.certs/claude-mobile
#   mkcert -cert-file ~/.certs/claude-mobile/cert.pem \
#          -key-file  ~/.certs/claude-mobile/key.pem  \
#          localhost 127.0.0.1 $(ipconfig getifaddr en0)
#
# Then on each phone/device: install the mkcert root CA once.
# The CA file is at: $(mkcert -CAROOT)/rootCA.pem
# AirDrop or email it to each device and install it as a trusted cert.

DIR="$(cd "$(dirname "$0")" && pwd)"

DEFAULT_CERT="$HOME/.certs/claude-mobile/cert.pem"
DEFAULT_KEY="$HOME/.certs/claude-mobile/key.pem"
DEFAULT_SESSION_IGNORE_GLOBS='**/.claude-unleashed/**,/private/**,/tmp/**'

USE_HTTPS=false
CERT_FILE=""
KEY_FILE=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stop)
      echo "Stopping Claude Mobile UI..."
      pkill -f "caffeinate.*node server.js" 2>/dev/null
      pkill -f "node server.js" 2>/dev/null
      echo "Done."
      exit 0
      ;;
    --https)
      USE_HTTPS=true
      shift
      ;;
    --cert)
      CERT_FILE="$2"
      shift 2
      ;;
    --key)
      KEY_FILE="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Resolve cert paths
if [ "$USE_HTTPS" = true ]; then
  CERT_FILE="${CERT_FILE:-$DEFAULT_CERT}"
  KEY_FILE="${KEY_FILE:-$DEFAULT_KEY}"

  if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
    echo ""
    echo "  ERROR: HTTPS certs not found."
    echo "  Expected:"
    echo "    cert: $CERT_FILE"
    echo "    key:  $KEY_FILE"
    echo ""
    echo "  Run the one-time setup:"
    echo "    brew install mkcert && mkcert -install"
    echo "    mkdir -p ~/.certs/claude-mobile"
    echo "    mkcert -cert-file ~/.certs/claude-mobile/cert.pem \\"
    echo "           -key-file  ~/.certs/claude-mobile/key.pem \\"
    echo "           localhost 127.0.0.1 \$(ipconfig getifaddr en0)"
    echo ""
    exit 1
  fi
fi

# Check for an existing instance and kill it if found
if pgrep -f "node server.js" > /dev/null 2>&1; then
  echo "  Found existing Claude Mobile UI server running — stopping it..."
  pkill -f "caffeinate.*node server.js" 2>/dev/null
  pkill -f "node server.js" 2>/dev/null
  sleep 1
  echo "  Stopped."
else
  echo "  No existing server running."
fi

echo ""
if [ "$USE_HTTPS" = true ]; then
  echo "  Starting Claude Mobile UI (HTTPS)..."
  export CERT_PATH="$CERT_FILE"
  export KEY_PATH="$KEY_FILE"
else
  echo "  Starting Claude Mobile UI (HTTP)..."
  echo "  Tip: run with --https for full feature support"
fi
echo "  Mac will stay awake (display can turn off)"
echo "  Press Ctrl+C to stop"
echo ""

export SESSION_IGNORE_GLOBS="${SESSION_IGNORE_GLOBS:-$DEFAULT_SESSION_IGNORE_GLOBS}"

cd "$DIR" && caffeinate -dims node server.js
