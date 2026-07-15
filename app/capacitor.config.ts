/// <reference types="@capacitor/cli" />
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Apple Bundle ID — change to your actual ID once you have a paid Apple Developer account.
  // Apple requires reverse-DNS format. The ID must be unique across the App Store.
  appId: 'app.mine.dashboard',
  appName: 'MINE',

  // ── Web root ──────────────────────────────────────────────────────────
  // We use the "remote URL load" pattern: the native shell launches and
  // immediately points its WebView at the deployed MINE backend, which
  // serves the live HTML dashboards. This means:
  //
  //   • Updates to MINE web don't need an App Store re-submission
  //   • The native shell is small (< 5 MB) and rarely needs updating
  //   • All MINE web features Just Work inside the app
  //
  // Alternative: bundle the HTML into the app (webDir: 'src'). Use that
  // for offline-first or App Store apps that don't want a remote URL.
  webDir: 'src',
  server: {
    // PROD: point at your deployed MINE backend
    url: 'https://app.mine.app',
    // DEV: allow localhost cleartext for local testing
    cleartext: true,
    androidScheme: 'https',
    iosScheme: 'https',
    // Required for OAuth redirects, Stripe Checkout return URL, etc.
    allowNavigation: [
      'app.mine.app',
      '*.mine.app',
      'checkout.stripe.com',
      'connect.stripe.com',
      'js.stripe.com',
      'accounts.google.com',
      'login.mailchimp.com',
      '*.myshopify.com',
    ],
  },

  // ── Plugin config ──────────────────────────────────────────────────────
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#4F46E5', // MINE purple
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
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
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Camera: {
      // Default UX prompts
    },
    BarcodeScanner: {
      // ML Kit on-device scanning — no internet needed
    },
  },

  // ── iOS-specific ───────────────────────────────────────────────────────
  ios: {
    // Required entitlements registered in Xcode project AFTER `npx cap add ios`:
    //
    //   com.apple.developer.proximity-reader.payment.acceptance
    //     ← Apple Tap to Pay on iPhone (requires Apple approval)
    //
    //   aps-environment = production
    //     ← Push notifications
    //
    //   com.apple.developer.associated-domains (for Universal Links)
    //
    // Min iOS: 16.4 (Tap to Pay requirement)
    // iPhone XS or newer required for Tap to Pay
    contentInset: 'always',
    backgroundColor: '#4F46E5',
    limitsNavigationsToAppBoundDomains: false,
  },

  // ── Android-specific ───────────────────────────────────────────────────
  android: {
    backgroundColor: '#4F46E5',
    // Tap to Pay on Android uses Google's "Tap to Pay" via the Stripe Terminal
    // SDK. Requires NFC permission in AndroidManifest.xml.
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
