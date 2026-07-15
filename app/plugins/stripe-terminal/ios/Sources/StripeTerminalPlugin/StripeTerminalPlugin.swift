import Foundation
import Capacitor
import StripeTerminal

/**
 * MINE Stripe Terminal Plugin — Tap to Pay on iPhone
 *
 * Implements the native iOS side of the JavaScript StripeTerminal interface.
 * Customer taps a contactless card or Apple Pay phone on the back of the
 * MINE user's iPhone, and the payment is collected through Stripe Terminal SDK.
 *
 * REQUIREMENTS:
 *   - iOS 16.4+
 *   - iPhone XS or newer (NFC chip required)
 *   - Stripe account with Tap to Pay enabled
 *   - Apple Developer entitlement:
 *     com.apple.developer.proximity-reader.payment.acceptance
 *     (request via Apple Developer Portal — typically 2-4 week review)
 *   - Add Stripe Terminal SDK to Podfile:
 *     pod 'StripeTerminal', '~> 3.0'
 *
 * BACKEND ENDPOINTS REQUIRED (already implemented in features.js):
 *   POST /api/features/stripe-terminal/connection-token
 *     Returns: { secret: "pst_test_xxx" }
 *   POST /api/features/stripe-terminal/create-payment-intent
 *     Body: { amount, currency, invoice_id }
 *     Returns: { client_secret, payment_intent_id }
 *   POST /api/features/stripe-terminal/capture
 *     Body: { payment_intent_id }
 *     Returns: { status, charge_id }
 */
@objc(StripeTerminalPlugin)
public class StripeTerminalPlugin: CAPPlugin, ConnectionTokenProvider, DiscoveryDelegate, TerminalDelegate {

    private var currentPaymentCall: CAPPluginCall?
    private var connectedReader: Reader?
    private var discoveryCancelable: Cancelable?

    public override func load() {
        Terminal.setTokenProvider(self)
        Terminal.shared.delegate = self
    }

    // MARK: - ConnectionTokenProvider

    public func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        guard let backendURL = getBackendURL() else {
            completion(nil, NSError(domain: "MineStripeTerminal", code: 1, userInfo: [NSLocalizedDescriptionKey: "MINE backend URL not configured"]))
            return
        }
        let url = URL(string: "\(backendURL)/api/features/stripe-terminal/connection-token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let authToken = getAuthToken() {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error { completion(nil, error); return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let secret = json["secret"] as? String else {
                completion(nil, NSError(domain: "MineStripeTerminal", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid connection token response"]))
                return
            }
            completion(secret, nil)
        }.resume()
    }

    private func getBackendURL() -> String? {
        // Read from Info.plist or environment.
        // Default to production app.mine.app
        return Bundle.main.object(forInfoDictionaryKey: "MineBackendURL") as? String ?? "https://app.mine.app"
    }

    private func getAuthToken() -> String? {
        // Read from WebView's localStorage (where MINE stores 'mine_token').
        // This is set by the dashboard after login.
        return UserDefaults.standard.string(forKey: "mine_token")
    }

    // MARK: - Plugin Methods

    @objc func checkCapability(_ call: CAPPluginCall) {
        // Tap to Pay availability check
        let supported = Terminal.shared.supportsReaders(of: .tapToPay, discoveryMethod: .localMobile, simulated: false)
        if case .success = supported {
            call.resolve([
                "supported": true
            ])
        } else {
            var reason = "Device does not support Tap to Pay"
            if case .failure(let error) = supported {
                reason = error.localizedDescription
            }
            call.resolve([
                "supported": false,
                "reason": reason
            ])
        }
    }

    @objc func initialize(_ call: CAPPluginCall) {
        // Discovery + reader connection happens on demand in collectPayment.
        // This method exists for future pre-warming.
        call.resolve(["initialized": true])
    }

    @objc func collectPayment(_ call: CAPPluginCall) {
        guard let amount = call.getInt("amount"),
              let currency = call.getString("currency"),
              let invoiceId = call.getString("invoice_id") else {
            call.reject("amount, currency, and invoice_id required")
            return
        }
        let description = call.getString("description") ?? "Invoice \(invoiceId)"

        self.currentPaymentCall = call

        // 1. Discover the local mobile reader (Tap to Pay)
        let discoveryConfig: DiscoveryConfiguration
        do {
            discoveryConfig = try LocalMobileDiscoveryConfigurationBuilder().build()
        } catch {
            call.reject("Failed to build discovery config: \(error.localizedDescription)")
            return
        }

        self.discoveryCancelable = Terminal.shared.discoverReaders(discoveryConfig, delegate: self) { error in
            // discovery starts; reader appears in DiscoveryDelegate callback below
            if let error = error {
                call.reject("Reader discovery failed: \(error.localizedDescription)")
                self.currentPaymentCall = nil
            }
        }

        // Store the desired payment params for use after reader connects
        UserDefaults.standard.set(amount, forKey: "_mine_pending_amount")
        UserDefaults.standard.set(currency, forKey: "_mine_pending_currency")
        UserDefaults.standard.set(invoiceId, forKey: "_mine_pending_invoice")
        UserDefaults.standard.set(description, forKey: "_mine_pending_desc")
    }

    @objc func cancelPayment(_ call: CAPPluginCall) {
        if let cancelable = discoveryCancelable {
            cancelable.cancel { _ in }
            discoveryCancelable = nil
        }
        if let currentCall = currentPaymentCall {
            currentCall.resolve([
                "status": "cancelled"
            ])
            currentPaymentCall = nil
        }
        call.resolve()
    }

    // MARK: - DiscoveryDelegate

    public func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        guard let reader = readers.first else { return }
        // Auto-connect to the first (and only) Tap to Pay reader
        let connectionConfig: ConnectionConfiguration
        do {
            connectionConfig = try LocalMobileConnectionConfigurationBuilder(locationId: "")
                .setOnBehalfOf(nil)
                .setMerchantDisplayName("MINE")
                .build()
        } catch {
            currentPaymentCall?.reject("Connection config error: \(error.localizedDescription)")
            currentPaymentCall = nil
            return
        }
        Terminal.shared.connectReader(reader, connectionConfig: connectionConfig) { [weak self] connectedReader, error in
            guard let self = self else { return }
            if let error = error {
                self.currentPaymentCall?.reject("Connect failed: \(error.localizedDescription)")
                self.currentPaymentCall = nil
                return
            }
            self.connectedReader = connectedReader
            self.proceedWithPaymentIntent()
        }
    }

    private func proceedWithPaymentIntent() {
        let amount = UInt(UserDefaults.standard.integer(forKey: "_mine_pending_amount"))
        let currency = UserDefaults.standard.string(forKey: "_mine_pending_currency") ?? "aud"
        let invoiceId = UserDefaults.standard.string(forKey: "_mine_pending_invoice") ?? ""

        // 1. Backend creates PaymentIntent, returns client_secret
        guard let backendURL = getBackendURL() else {
            currentPaymentCall?.reject("Backend URL missing")
            return
        }
        let url = URL(string: "\(backendURL)/api/features/stripe-terminal/create-payment-intent")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authToken = getAuthToken() {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        let body: [String: Any] = ["amount": amount, "currency": currency, "invoice_id": invoiceId]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let clientSecret = json["client_secret"] as? String else {
                DispatchQueue.main.async {
                    self.currentPaymentCall?.reject("PaymentIntent creation failed")
                    self.currentPaymentCall = nil
                }
                return
            }
            // 2. Retrieve PaymentIntent
            Terminal.shared.retrievePaymentIntent(clientSecret: clientSecret) { intent, error in
                if let error = error {
                    DispatchQueue.main.async {
                        self.currentPaymentCall?.reject("Retrieve PI failed: \(error.localizedDescription)")
                        self.currentPaymentCall = nil
                    }
                    return
                }
                guard let intent = intent else { return }
                // 3. Collect payment method via Tap to Pay (Apple's sheet appears)
                Terminal.shared.collectPaymentMethod(intent) { collected, error in
                    if let error = error {
                        DispatchQueue.main.async {
                            self.currentPaymentCall?.reject("Collect failed: \(error.localizedDescription)")
                            self.currentPaymentCall = nil
                        }
                        return
                    }
                    guard let collected = collected else { return }
                    // 4. Confirm
                    Terminal.shared.confirmPaymentIntent(collected) { confirmed, error in
                        DispatchQueue.main.async {
                            if let error = error {
                                self.currentPaymentCall?.reject("Confirm failed: \(error.localizedDescription)")
                            } else if let confirmed = confirmed {
                                let last4 = (confirmed.charges.first?.paymentMethodDetails?.cardPresent?.last4) ?? ""
                                let brand = (confirmed.charges.first?.paymentMethodDetails?.cardPresent?.brand.description) ?? ""
                                self.currentPaymentCall?.resolve([
                                    "status": "succeeded",
                                    "payment_intent_id": confirmed.stripeId ?? "",
                                    "charge_id": confirmed.charges.first?.stripeId ?? "",
                                    "last4": last4,
                                    "brand": brand,
                                ])
                                // Also notify backend so MINE can mark the invoice paid immediately
                                self.notifyBackendOfCapture(paymentIntentId: confirmed.stripeId ?? "")
                            }
                            self.currentPaymentCall = nil
                        }
                    }
                }
            }
        }.resume()
    }

    private func notifyBackendOfCapture(paymentIntentId: String) {
        guard let backendURL = getBackendURL() else { return }
        let url = URL(string: "\(backendURL)/api/features/stripe-terminal/capture")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authToken = getAuthToken() {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["payment_intent_id": paymentIntentId])
        URLSession.shared.dataTask(with: request).resume()
    }

    // MARK: - TerminalDelegate

    public func terminal(_ terminal: Terminal, didReportUnexpectedReaderDisconnect reader: Reader) {
        // Reader unexpectedly disconnected
        connectedReader = nil
    }
}
