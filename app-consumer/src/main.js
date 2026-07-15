/**
 * MINE customer-app native bridge
 *
 * Mirrors the owner app's pattern (../app/src/main.js): exposes a trimmed,
 * customer-relevant set of Capacitor APIs to the MINE web via window.MineNative.
 * The consumer entry (/m) and business apps (/app) check for this object to use
 * native capabilities when available and fall back to web otherwise.
 *
 *   if (window.MineNative) { MineNative.scanQR(); } else { /* web fallback *\/ }
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

window.MineNative = {
  version: '1.0.0',
  platform,
  role: 'customer',

  // ── Storage (Keychain / Keystore) — remember which businesses I've joined ──
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

  // ── QR / barcode scan — scan a business's QR to open its app ──────────────
  async scanQR() {
    const { barcodes } = await BarcodeScanner.scan();
    return barcodes[0]?.rawValue || null;
  },

  // ── Push notifications — announcements / reminders / offers from businesses ─
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

  // ── Share a business with a friend ────────────────────────────────────────
  async share(options) {
    await Share.share({
      title: options.title,
      text: options.text,
      url: options.url,
      dialogTitle: options.dialogTitle || 'Share',
    });
  },

  // ── In-app browser (payment confirmations, external links) ────────────────
  async openBrowser(url) {
    await Browser.open({ url, presentationStyle: 'fullscreen' });
  },

  async getNetworkStatus() {
    return await Network.getStatus();
  },

  async hapticTap() {
    await Haptics.impact({ style: ImpactStyle.Light });
  },
  async hapticSuccess() {
    await Haptics.impact({ style: ImpactStyle.Medium });
  },

  async hideKeyboard() {
    if (platform !== 'web') await Keyboard.hide();
  },

  async setStatusBarStyle(style) {
    await StatusBar.setStyle({ style: style === 'dark' ? Style.Dark : Style.Light });
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Event wiring
// ────────────────────────────────────────────────────────────────────────────

// Hide the boot splash once the WebView has loaded the entry page
setTimeout(() => SplashScreen.hide(), 800);

// Push token → register against the backend so businesses can reach this device
PushNotifications.addListener('registration', (token) => {
  console.log('[MineNative/customer] Push token:', token.value);
  fetch(`${window.MINE_API || 'https://app.mine.app'}/api/push-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.value, platform, role: 'customer' }),
  }).catch((e) => console.warn('Failed to register push token:', e.message));
});

PushNotifications.addListener('pushNotificationReceived', (notification) => {
  window.dispatchEvent(new CustomEvent('mine:push', { detail: notification }));
});

PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
  window.dispatchEvent(new CustomEvent('mine:push-action', { detail: action }));
});

App.addListener('appStateChange', ({ isActive }) => {
  window.dispatchEvent(new CustomEvent('mine:appStateChange', { detail: { isActive } }));
});

// Deep links — open a business directly: mine://join/ABC123 or https://app.mine.app/m/ABC123
App.addListener('appUrlOpen', (data) => {
  window.dispatchEvent(new CustomEvent('mine:deepLink', { detail: { url: data.url } }));
  try {
    const m = String(data.url || '').match(/(?:join\/|\/m\/)([A-Za-z0-9]{4,12})/);
    if (m && m[1]) window.location.href = 'https://app.mine.app/m/' + m[1].toUpperCase();
  } catch (_) {}
});

App.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) window.history.back();
  else App.exitApp();
});

console.log('[MineNative/customer] Native bridge ready on', platform);
