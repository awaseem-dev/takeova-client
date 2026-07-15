#!/bin/bash
echo "🚀 Starting MINE backend..."

# Check required env vars
required=("JWT_SECRET" "STRIPE_SECRET_KEY" "SENDGRID_API_KEY" "ANTHROPIC_API_KEY" "INTERNAL_API_KEY" "CRON_SECRET")
missing=()
for var in "${required[@]}"; do
  if [ -z "${!var}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "⚠️  Missing env vars: ${missing[*]}"
  echo "   Copy .env.example to .env and fill in values"
  exit 1
fi

mkdir -p data uploads
node server.js
