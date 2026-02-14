/**
 * Paddle webhook payload (transaction.completed).
 * See: https://developer.paddle.com/webhooks/transactions/transaction-completed
 */
export interface PaddleWebhookPayload {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id: string;
  data: {
    id: string;
    status: string;
    customer_id: string | null;
    currency_code: string;
    items: Array<{
      price?: { id: string; name?: string };
      product?: { id: string; name?: string };
    }>;
    details?: {
      line_items?: Array<{ totals: { total: string }; product?: { name?: string } }>;
    };
    checkout?: {
      customer?: { email?: string };
    };
  };
}

/** Customer email from Paddle payload (checkout or nested). */
export function getCustomerEmail(data: PaddleWebhookPayload["data"]): string {
  const email = data.checkout?.customer?.email;
  if (email) return email;
  return "noreply@example.com";
}

export interface KVTransactionRecord {
  downloadToken: string;
  createdAt: string;
}

export interface KVTokenRecord {
  productId: string;
  r2Key: string;
  expiresAt: string;
}

/**
 * Map Paddle price_id to R2 object key.
 * Add entries when you add new products.
 */
export const PRICE_TO_R2_KEY: Record<string, string> = {
  // Example: "pri_xxxxxxxxxxxxx": "products/your-product.zip",
};
