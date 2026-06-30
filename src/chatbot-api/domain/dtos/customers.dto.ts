export interface CustomerDeliveryAddressResponse {
  id: string;
  label: string | null;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  visualReferences: string | null;
  carrierPhone: string | null;
}

export interface CustomerProfileResponse {
  customerId: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  preferredPaymentMethod: string | null;
  address: CustomerDeliveryAddressResponse | null;
}

export interface CustomerLookupResponse {
  found: boolean;
  customer: CustomerProfileResponse | null;
}

export interface CustomerUpsertInput {
  firstName: string;
  lastName?: string;
  phoneCountryCode: string;
  phone: string;
  preferredPaymentMethod?: string;
  address: {
    label?: string;
    street: string;
    exteriorNumber?: string;
    interiorNumber?: string;
    zipCode?: string;
    neighborhood?: string;
    municipality?: string;
    city?: string;
    state?: string;
    visualReferences?: string;
    carrierPhone?: string;
  };
}

export interface CustomerUpsertResponse {
  status: 'created' | 'updated';
  customer: CustomerProfileResponse;
}
