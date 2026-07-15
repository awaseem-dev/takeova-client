/// <reference types="@capacitor/cli" />
import { CapacitorConfig } from '@capacitor/cli';

// ───────────────────────────────────────────────────────────────────────────
// MINE — CONSUMER app
//
// This is the *customer-facing* companion to the owner app in ../app.
//   • ../app           → the business OWNER's app (loads the dashboard, Tap to Pay)
//   • ./  (this folder) → the CUSTOMER's app: a person downloads "MINE", enters
//                         the join code their gym/cafe/studio gave them, and the
//                         WebView opens that business's branded app (/app).
//
// Same remote-URL-load pattern as the owner app: the native shell launches and
// points its WebView at the deployed MINE backend's consumer entry (/m). When
// the customer enters a code, /m redirects to <slug>.mine.app/app — which is
// whitelisted below, so it stays inside the app.
// ───────────────────────────────────────────────────────────────────────────

const config: CapacitorConfig = {
  // Reverse-DNS, must be unique on the App Store. Distinct from the owner app
  // (app.mine.dashboard) so both can ship side by side.
  appId: 'app.mine.customer',
  // If you ship BOTH apps, give them different store names — e.g. owner app
  // "MINE Business" and this one "MINE". They can't share an identical name.
  appName: 'MINE',

  webDir: 'src',
  server: {
    // Boots straight into the join-code entry page served by the backend.
    url: 'https://app.mine.app/m',
    cleartext: true,
    androidScheme: 'https',
    iosScheme: 'https',
    // Keep navigation in-app for the consumer entry and every business app
    // served on a *.mine.app subdomain (that's why the resolver prefers the
    // subdomain over a custom domain). Custom-domain businesses open in the
    // system browser.
    allowNavigation: [
      'app.mine.app',
      '*.mine.app',
      'checkout.stripe.com',
      'js.stripe.com',
    ],
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#4F46E5',
      showSpinner: true,
      spinnerColor: '#FFFFFF',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#4F46E5',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    // Customers receive announcements / reminders / offers from the businesses
    // they've joined.
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    // On-device QR scan so a customer can scan a business's QR instead of
    // typing the join code.
    BarcodeScanner: {},
  },

  ios: {
    // aps-environment = production  (push)  — registered in Xcode after `npx cap add ios`
    // associated-domains            (Universal Links, optional)
    contentInset: 'always',
    backgroundColor: '#4F46E5',
    limitsNavigationsToAppBoundDomains: false,
  },

  android: {
    backgroundColor: '#4F46E5',
    allowMixedContent: false,
  },
};

export default config;
