/**
 * Paddle webhook payload (transaction.completed).
 * See: https://developer.paddle.com/webhooks/transactions/transaction-completed
 */

/** Custom data that can appear on products, prices, or transactions. */
export interface PaddleCustomData {
  download_path?: string;
  sku?: string;
  product_name?: string;
  [key: string]: unknown;
}

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
      price?: {
        id: string;
        name?: string;
        custom_data?: PaddleCustomData | null;
      };
      product?: {
        id: string;
        name?: string;
        custom_data?: PaddleCustomData | null;
      };
    }>;
    details?: {
      totals?: { total: string; grand_total: string };
      line_items?: Array<{
        totals: { total: string };
        product?: { name?: string };
      }>;
    };
    checkout?: {
      customer?: { email?: string };
    };
    custom_data?: PaddleCustomData | null;
  };
}

/** Extract customer email from the Paddle payload. */
export function getCustomerEmail(data: PaddleWebhookPayload["data"]): string {
  return data.checkout?.customer?.email || "";
}

export interface KVTransactionRecord {
  downloadToken: string;
  createdAt: string;
}

export interface KVTokenRecord {
  r2Key: string;
  expiresAt: string;
}
