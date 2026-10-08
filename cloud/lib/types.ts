export type FileKind = 'design' | 'sample_bill' | 'sample_invoice' | 'quote' | 'deposit_invoice' | 'balance_invoice' | 'pi' | 'internal';
export interface FileRecord {
  id: string; name: string; stored: string; kind: FileKind; createdAt: string;
  objectKey?: string; size?: number; contentType?: string; sha256?: string;
}
export interface OrderItem {color: string; quantity: number; unitPrice: number;}
export interface Order {
  id: string; orderNo: string; code: string; styleNo: string; version: number;
  createdAt: string; updatedAt: string; files: FileRecord[]; items: OrderItem[]; history: {at: string; text: string}[];
  workflowConfirmed: boolean; dataComplete: boolean; sampleRequired: boolean;
  sampleStage: string; productionStatus: string; sampleDue: string; productionDue: string;
  requirements: string; specifications: string; printDetails: string; packaging: string;
  sampleBill: string; sampleInvoice: string; samplePaid: boolean; samplePaidDate: string;
  invoiceRequired: boolean; taxMode: string; shipping: number; sampleFee: number;
  deposit: number; depositReceived: boolean; depositInvoice: string; balanceReceived: boolean;
  balanceInvoice: string; buyer: string; internalNotes: string;
}
export interface CloudEnv {
  DB: D1Database; BUCKET: R2Bucket;
  INITIAL_ADMIN_PASSWORD?: string; MAC_SYNC_TOKEN?: string;
}
export interface DocumentMutation {order: Order; createdKeys: string[];}
