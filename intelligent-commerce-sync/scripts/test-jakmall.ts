export interface JakmallPrice{
    list: number | null;
    normal: number | null;
    final: number | null;
    discountPercentage: number | null;
}

export interface JakmallStock{
    status:
    | "in_stock"
    | "limited"
    | "out_of_stock"
    | "coming_soon"
    | "unknown";

    quantity: number | null;
    exact: boolean;
}

export interface JakmallImage{
    icon?: string;
    thumbnail?: string;
    detail?: string;
}

export interface JakmallVariant{
    skuId: string;
    attributes: Record<string, string>;
    price: JakmallPrice;
    stock: JakmallStock;
    weightGrams: number | null;
    image?: JakmallImage[];
    preorder: boolean;
    sourceUrl: string;
}

export interface JakmallProduct{
    source: "jakmall";
    productId: string;
    sourceUrl: string;
    title: string;
    description: string;
    brand: string | null;
    categoryPath: string[];
    store:{
        id: string | null;
        name: string | null;
    };

    shippingOrigin: {
        city: string | null;
        location: string | null;
    };

    variants: JakmallVariant[];

    fetchedAt: string;

}