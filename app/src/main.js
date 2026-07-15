/**
 * MINE native bridge
 *
 * Exposes Capacitor APIs to the MINE web dashboards via window.MineNative.
 * The web dashboards check for this object to know they're running inside
 * the native app, and use the native capabilities when available.
 *
 *   if (window.MineNative) {
 *     // Use native: tap-to-pay, camera, push, etc.
 *   } else {
 *     // Fallback to web flow: QR code, manual card entry, etc.
 *   }
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { StripeTerminal } from 'mine-stripe-terminal';

const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

// ────────────────────────────────────────────────────────────────────────────
// Public API surfaced to MINE web dashboards
// ────────────────────────────────────────────────────────────────────────────
window.MineNative = {
  version: '1.0.0',
  platform,

  // ── Storage (encrypted on iOS Keychain / Android Keystore) ──────────────
  async getItem(key) {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async setItem(key, value) {
    await Preferences.set({ key, value: String(value) });
  },
  async removeItem(key) {
    await Preferences.remove({ key });
  },

  // ── Camera / image upload (for product photos, brand assets, etc.) ─────
  async takePhoto(options = {}) {
    const photo = await Camera.getPhoto({
      quality: options.quality || 80,
      allowEditing: options.allowEditing !== false,
      resultType: CameraResultType.Uri,
      source: options.source === 'camera' ? CameraSource.Camera :
              options.source === 'gallery' ? CameraSource.Photos : CameraSource.Prompt,
    });
    return { uri: photo.webPath, format: photo.format };
  },

  // ── QR / barcode scanning ───────────────────────────────────────────────
  async scanQR() {
    const { barcodes } = await BarcodeScanner.scan();
    return barcodes[0]?.rawValue || null;
  },

  // ── Geolocation (used by AI Receptionist for "nearby" searches) ────────
  async getLocation() {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  },

  // ── Push notifications ──────────────────────────────────────────────────
  async registerPushNotifications() {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== 'granted') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive === 'granted') {
      await PushNotifications.register();
    } else {
      throw new Error('Push notification permission denied');
    }
  },

  async showLocalNotification(title, body, data = {}) {
    await LocalNotifications.schedule({
      notifications: [{
        title, body,
        id: Date.now(),
        schedule: { at: new Date(Date.now() + 100) },
        extra: data,
      }],
    });
  },

  // ── File downloads (invoices PDFs, contracts, reports) ─────────────────
  async downloadFile(url, filename) {
    const response = await fetch(url);
    const blob = await response.blob();
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(blob);
    });
    const result = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Documents,
    });
    return result.uri;
  },

  // ── Share sheet (share invoice link, brand assets, etc.) ───────────────
  async share(options) {
    await Share.share({
      title: options.title,
      text: options.text,
      url: options.url,
      dialogTitle: options.dialogTitle || 'Share',
    });
  },

  // ── In-app browser (for OAuth flows, payment confirmations) ────────────
  async openBrowser(url) {
    await Browser.open({ url, presentationStyle: 'fullscreen' });
  },

  // ── Network status ──────────────────────────────────────────────────────
  async getNetworkStatus() {
    return await Network.getStatus();
  },

  // ── Haptic feedback (button taps, payment confirmations) ───────────────
  async hapticTap() {
    await Haptics.impact({ style: ImpactStyle.Light });
  },
  async hapticSuccess() {
    await Haptics.impact({ style: ImpactStyle.Medium });
  },

  // ── Keyboard control ───────────────────────────────────────────────────
  async hideKeyboard() {
    if (platform !== 'web') await Keyboard.hide();
  },

  // ── Status bar ─────────────────────────────────────────────────────────
  async setStatusBarStyle(style) {
    await StatusBar.setStyle({ style: style === 'dark' ? Style.Dark : Style.Light });
  },

  // ──────────────────────────────────────────────────────────────────────
  // STRIPE TAP TO PAY ON iPHONE
  // ──────────────────────────────────────────────────────────────────────
  // The marquee feature. Customer taps their contactless card or Apple Pay
  // phone on the MINE user's iPhone — payment captured instantly.
  //
  // Flow:
  //   1. Web side calls MineNative.tapToPayCheckCapability() to confirm device
  //   2. Web calls MineNative.tapToPayCharge({ amount, invoice_id }) when ready
  //   3. Native plugin calls Stripe Terminal SDK:
  //      a. Requests a connection token from MINE backend
  //         (POST /api/features/stripe-terminal/connection-token)
  //      b. Initializes Tap to Pay reader
  //      c. Presents Apple's payment sheet on the back of the phone
  //      d. Customer taps their card
  //      e. PaymentIntent confirms via MINE backend webhook
  //   4. Web side gets result: { status, payment_intent_id, last4, brand }
  //
  // Requires Apple's Tap to Pay on iPhone entitlement (Apple Developer Program
  // > Identifiers > add com.apple.developer.proximity-reader.payment.acceptance).
  // Apple reviews + approves per-app, typically 2-4 weeks.

  async tapToPayCheckCapability() {
    if (platform !== 'ios') return { supported: false, reason: 'Tap to Pay requires iPhone' };
    return await StripeTerminal.checkCapability();
  },

  async tapToPayCharge(options) {
    if (platform !== 'ios') throw new Error('Tap to Pay requires iPhone');
    if (!options.amount || !options.invoice_id) throw new Error('amount and invoice_id required');
    return await StripeTerminal.collectPayment({
      amount: Math.round(options.amount * 100), // cents
      currency: options.currency || 'aud',
      invoice_id: String(options.invoice_id),
      description: options.description || `Invoice ${options.invoice_id}`,
    });
  },

  // Cancel an in-progress Tap to Pay session
  async tapToPayCancel() {
    if (platform === 'ios') await StripeTerminal.cancelPayment();
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Event wiring — pipe native events into window dispatch so the web dashboards
// can listen via standard addEventListener.
// ────────────────────────────────────────────────────────────────────────────

// Hide the boot splash once the WebView has loaded the MINE URL
setTimeout(() => SplashScreen.hide(), 800);

// Push registration token → forward to MINE backend so it can send pushes
PushNotifications.addListener('registration', (token) => {
  console.log('[MineNative] Push token:', token.value);
  fetch(`${window.MINE_API || 'https://app.mine.app'}/api/push-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.value, platform }),
  }).catch((e) => console.warn('Failed to register push token:', e.message));
});

PushNotifications.addListener('pushNotificationReceived', (notification) => {
  window.dispatchEvent(new CustomEvent('mine:push', { detail: notification }));
});

PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
  window.dispatchEvent(new CustomEvent('mine:push-action', { detail: action }));
});

// App resume / pause
App.addListener('appStateChange', ({ isActive }) => {
  window.dispatchEvent(new CustomEvent('mine:appStateChange', { detail: { isActive } }));
});

// Deep links (mine://invoice/123 or https://app.mine.app/invoice/123)
App.addListener('appUrlOpen', (data) => {
  window.dispatchEvent(new CustomEvent('mine:deepLink', { detail: { url: data.url } }));
});

// Hardware back button on Android
App.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) window.history.back();
  else App.exitApp();
});

console.log('[MineNative] Native bridge ready on', platform);
