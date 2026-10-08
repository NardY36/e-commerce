/** Mock inventory for the Bole cosmetics store. Stands in for a products table. */
export interface InventoryItem {
  sku: string;
  name: string;
  priceEtb: number;
  stock: number;
}

export const STORE_INVENTORY: InventoryItem[] = [
  { sku: "CRV-HC-236", name: "CeraVe Hydrating Cleanser 236ml", priceEtb: 2500, stock: 12 },
  { sku: "CRV-FM-52", name: "CeraVe Foaming Facial Cleanser 52ml", priceEtb: 1800, stock: 7 },
  { sku: "NIV-SUN-50", name: "Nivea Sun SPF50 200ml", priceEtb: 1450, stock: 0 },
  { sku: "ORD-NIA-30", name: "The Ordinary Niacinamide 10% 30ml", priceEtb: 2100, stock: 23 },
  { sku: "VAS-LIP-20", name: "Vaseline Lip Therapy 20g", priceEtb: 450, stock: 40 },
  { sku: "CET-MOI-100", name: "Cetaphil Moisturising Lotion 100ml", priceEtb: 2300, stock: 4 },
];
