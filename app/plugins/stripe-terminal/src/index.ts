import { registerPlugin } from '@capacitor/core';

export interface CapabilityResult {
  supported: boolean;
  reason?: string;
}

export interface CollectPaymentOptions {
  amount: number;       // in cents (e.g. 1850 = $18.50)
  currency: string;     // ISO 4217 (e.g. 'aud')
  invoice_id: string;
  description?: string;
}

export interface PaymentResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  payment_intent_id?: string;
  charge_id?: string;
  last4?: string;
  brand?: string;          // 'visa' | 'mastercard' | 'amex' etc.
  error?: string;
}

export interface StripeTerminalPlugin {
  /** Returns whether this device supports Tap to Pay on iPhone */
  checkCapability(): Promise<CapabilityResult>;

  /** Initialize the SDK + fetch a connection token from MINE backend.
   *  Called automatically by collectPayment; can be pre-warmed at app start. */
  initialize(): Promise<{ initialized: boolean }>;

  /** Collect a contactless payment via Tap to Pay.
   *  Apple's payment sheet appears on the back of the phone.
   *  Customer taps their card or Apple Pay phone. */
  collectPayment(options: CollectPaymentOptions): Promise<PaymentResult>;

  /** Cancel an in-progress payment collection */
  cancelPayment(): Promise<void>;
}

const StripeTerminal = registerPlugin<StripeTerminalPlugin>('StripeTerminal');

export { StripeTerminal };
