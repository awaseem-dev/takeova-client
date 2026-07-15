# MINE — Customer app

The customer-facing companion to the owner app in [`../app`](../app). Two different apps for two different audiences:

| App | Folder | Audience | Boots into | Marquee native feature |
|-----|--------|----------|-----------|------------------------|
| **MINE (owner)** | `../app` | Business owners | the dashboard (`app.mine.app`) | Tap to Pay on iPhone |
| **MINE (customer)** | `./` (this) | A business's customers | the join-code entry (`app.mine.app/m`) | QR scan + push |

## What it does

A person installs MINE, types the **join code** their gym / café / studio gave them (or scans the business's QR), and the WebView opens that business's branded app — booking, shop, loyalty, chat — served at `<slug>.mine.app/app`.

It uses the same **remote-URL-load** pattern as the owner app: the native shell is tiny and points its WebView at the deployed backend, so web updates ship without an App Store resubmission.

## Folder layout

```
app-consumer/
├── package.json            # Capacitor + consumer plugins (no Tap to Pay)
├── capacitor.config.ts     # server.url = https://app.mine.app/m
├── src/
│   ├── index.html          # Boot splash (~1s, then loads /m)
│   └── main.js             # window.MineNative bridge (push, QR scan, share, deep links)
└── README.md               # this file
```

`ios/` and `android/` **don't exist yet** — generate them with `npm run init` (runs `npx cap add ios` + `npx cap add android`). That step needs Xcode (macOS) / the Android SDK and can't be run in this repo's build sandbox.

## Backend pieces it relies on (already in the repo)

- `GET /m` and `GET /m/:code` — the join-code entry page (`backend/routes/mobile-pwa.js`).
- `GET /api/m/resolve/:code` — resolves a join code → a business's app URL. Prefers the `<slug>.mine.app` subdomain so the result stays in-app (whitelisted in `allowNavigation`).
- `GET /app`, `/app/manifest.webmanifest`, `/mine-sw.js`, `/app/icon.svg` — the per-business branded app, served on each customer site's own origin.
- A business's join code is created/persisted the first time its owner opens the mobile-app panel (`GET /api/mobile-app/config` upserts `mobile_app_config.join_code`).

## Get started

```bash
cd app-consumer
npm run init      # install + add ios & android (needs Xcode / Android SDK)
npm run ios       # open in Xcode
npm run android   # open in Android Studio
```

Before shipping:
- Set a unique `appId` if `app.mine.customer` is taken, and a distinct store **name** from the owner app (they can't share an identical name).
- iOS: add the `aps-environment` entitlement (push) in Xcode; optionally associated-domains for `mine://join/<code>` / Universal Links.
- Android: the push + NFC-free build needs no special hardware entitlement.
- Custom-domain businesses (not on `*.mine.app`) will open in the system browser rather than in-app, because their domain isn't in `allowNavigation`. If you want those in-app too, add them — or rely on the `<slug>.mine.app` URL the resolver already prefers.

## Honest status

- This is **project source only** — the same shape as the owner app. It has not been built into an `.ipa`/`.apk` or run on a device here (no native toolchain in the sandbox).
- It mirrors the owner app's remote-load + `window.MineNative` bridge pattern; verify the bridge end-to-end on a real device as you would for the owner app.
