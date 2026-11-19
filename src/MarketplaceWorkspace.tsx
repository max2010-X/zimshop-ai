import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownWideNarrow, ArrowLeft, ArrowUpRight, BadgeCheck, Camera, Check, CircleAlert, LoaderCircle,
  LogIn, LogOut, MapPin, MessageSquareText, Package, Pause, Phone, Play, Plus, Search,
  Pencil, ShoppingBag, Sparkles, Store, Trash2, Truck, UserPlus, X,
} from "lucide-react";
import "./marketplace.css";
import { apiBase } from "./api";

type SearchResult = {
  id: string;
  source: "marketplace" | "bot_catalog";
  product_name: string;
  description: string;
  price: string;
  currency: string | null;
  condition: "new" | "used" | "refurbished" | "reconditioned" | "grey_market" | null;
  image_url: string | null;
  in_stock: boolean | null;
  availability: string | null;
  details_confirmed_at: string;
  business_name: string | null;
  phone_number: string | null;
  location: string | null;
  delivery_available: boolean | null;
  delivery_areas: string | null;
  purchase_url: string | null;
  match_score: number;
  match_reasons: string[];
};

type Business = {
  id: string;
  business_name: string;
  phone_number: string;
  location: string;
  physical_address: string;
  legal_status: string;
  registration_details: string;
  delivery_available: boolean;
  delivery_areas: string;
};

type SellerProduct = {
  id: string;
  name: string;
  description: string;
  price: string;
  currency: "USD" | "ZWG";
  condition: "new" | "used" | "refurbished" | "reconditioned" | "grey_market";
  image_url: string | null;
  in_stock: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
  details_confirmed_at: string;
};

type SearchResponse = { results: SearchResult[]; understanding_mode?: string };
type ViewMode = "search" | "seller";
type SellerPage = "login" | "register" | "dashboard";
type MarketplaceWorkspaceProps = {
  initialMode?: ViewMode;
  onAuthenticated?: () => void;
  onUnauthenticated?: () => void;
};

const locations = ["Harare", "Bulawayo", "Chitungwiza", "Mutare", "Gweru", "Kwekwe", "Masvingo", "Marondera", "Chinhoyi", "Victoria Falls", "Bindura"];
const emptyBusiness: Business = { id: "", business_name: "", phone_number: "", location: "", physical_address: "", legal_status: "individual", registration_details: "", delivery_available: false, delivery_areas: "" };
const emptyProduct = { name: "", description: "", price: "", currency: "USD" as "USD" | "ZWG", condition: "new" as SellerProduct["condition"], image_url: "", in_stock: true };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return readJsonResponse<T>(response, "Request");
}

async function readJsonResponse<T>(response: Response, action: string): Promise<T> {
  const body = await response.text();
  let payload: unknown = null;
  if (body.trim()) {
    try {
      payload = JSON.parse(body);
    } catch {
      if (response.ok) throw new Error(`${action} returned an invalid response. Please try again.`);
    }
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload
      ? String(payload.detail)
      : body.trim() || `${action} failed (${response.status}).`;
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  if (!body.trim()) throw new Error(`${action} returned an empty response. Please try again.`);
  return payload as T;
}

function formatPrice(price: string, currency: string | null) {
  if (!currency) return price;
  const amount = Number(price);
  return Number.isFinite(amount) ? `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${currency} ${price}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatCondition(value: SellerProduct["condition"] | null) {
  if (!value) return null;
  return value === "grey_market" ? "Grey market" : value[0].toUpperCase() + value.slice(1);
}

function productImageUrl(value: string | null) {
  return value?.startsWith("/uploads/") || value?.startsWith("/api/v1/marketplace/product-images/")
    ? `${apiBase}${value}`
    : value;
}

function normalizeSearchResponse(payload: unknown): SearchResponse | null {
  if (Array.isArray(payload)) return { results: payload as SearchResult[] };
  if (!payload || typeof payload !== "object") return null;

  const response = payload as { results?: unknown; data?: unknown; understanding_mode?: unknown };
  if (Array.isArray(response.results)) {
    return {
      results: response.results as SearchResult[],
      understanding_mode: typeof response.understanding_mode === "string" ? response.understanding_mode : undefined,
    };
  }
  if (Array.isArray(response.data)) return { results: response.data as SearchResult[] };
  if (response.data && typeof response.data === "object" && Array.isArray((response.data as { results?: unknown }).results)) {
    const data = response.data as { results: SearchResult[]; understanding_mode?: unknown };
    return {
      results: data.results,
      understanding_mode: typeof data.understanding_mode === "string" ? data.understanding_mode : undefined,
    };
  }
  return null;
}

function placeOrderSmsHref(result: SearchResult, customerLocation: string) {
  if (result.source !== "marketplace" || !result.phone_number) return null;

  const phone = result.phone_number.replace(/[^\d+]/g, "");
  if (!phone) return null;

  const message = [
    `Hello ${result.business_name || "there"},`,
    "",
    "I found your product on ZimShop AI and would like to place an order.",
    "",
    `Product: ${result.product_name}`,
    `Listed Price: ${formatPrice(result.price, result.currency)}`,
    "Quantity: 1",
    `My location: ${customerLocation || "Not specified"}`,
    "",
    "Please confirm availability, final price and delivery options.",
    "",
    "Thank you.",
  ].join("\n");
  const separator = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "&" : "?";
  return `sms:${phone}${separator}body=${encodeURIComponent(message)}`;
}

export default function MarketplaceWorkspace({
  initialMode = "search",
  onAuthenticated,
  onUnauthenticated,
}: MarketplaceWorkspaceProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(initialMode);
  const [sellerPage, setSellerPage] = useState<SellerPage>(() => new URLSearchParams(window.location.search).get("auth") === "register" ? "register" : "login");
  const [query, setQuery] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [currency, setCurrency] = useState<"USD" | "ZWG">("USD");
  const [location, setLocation] = useState("");
  const [customLocation, setCustomLocation] = useState("");
  const [condition, setCondition] = useState<"any" | SellerProduct["condition"]>("any");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<SearchResult | null>(null);
  const [searchBusiness, setSearchBusiness] = useState<Business | null>(null);
  const [searchProfileLoading, setSearchProfileLoading] = useState(false);
  const [searchMode, setSearchMode] = useState("");
  const [searched, setSearched] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [sellerBusy, setSellerBusy] = useState(false);
  const [sellerError, setSellerError] = useState("");
  const [business, setBusiness] = useState<Business>(emptyBusiness);
  const [products, setProducts] = useState<SellerProduct[]>([]);
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [authDraft, setAuthDraft] = useState({ email: "", password: "", business_name: "", phone_number: "", location: "Harare", physical_address: "", legal_status: "individual", registration_details: "", terms_accepted: false, delivery_available: false, delivery_areas: "" });
  const [productDraft, setProductDraft] = useState(emptyProduct);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productBusy, setProductBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  async function loadSeller() {
    setSellerBusy(true);
    setSellerError("");
    try {
      const [account, sellerProducts] = await Promise.all([
        request<Business>("/api/v1/marketplace/seller/account"),
        request<SellerProduct[]>("/api/v1/marketplace/seller/products"),
      ]);
      setBusiness(account);
      setAuthDraft((current) => ({
        ...current,
        business_name: account.business_name,
        phone_number: account.phone_number,
        location: account.location,
        physical_address: account.physical_address,
        legal_status: account.legal_status,
        registration_details: account.registration_details,
        delivery_available: account.delivery_available,
        delivery_areas: account.delivery_areas,
      }));
      setProducts(sellerProducts);
      setSellerPage("dashboard");
      onAuthenticated?.();
    } catch (error) {
      setSellerPage("login");
      setSellerError(error instanceof Error && !error.message.includes("401") ? error.message : "Sign in or create a free seller account to manage your listings.");
    } finally {
      setSellerBusy(false);
    }
  }

  useEffect(() => {
    if (viewMode === "seller") void loadSeller();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "search") return;
    let active = true;
    setSearchProfileLoading(true);
    request<Business>("/api/v1/marketplace/seller/account")
      .then((account) => {
        if (active) setSearchBusiness(account);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSearchBusiness(null);
        if (!(error instanceof Error) || !error.message.includes("Sign in")) {
          setNotice(error instanceof Error ? error.message : "Could not load your business profile.");
        }
      })
      .finally(() => {
        if (active) setSearchProfileLoading(false);
      });
    return () => { active = false; };
  }, [viewMode]);

  async function search(sortBy: "best_match" | "price") {
    if (!query.trim()) {
      setNotice("Enter a product or a few product details to search.");
      return;
    }
    setSearchBusy(true);
    setNotice("");
    setSelectedProduct(null);
    setSearched(true);
    try {
      const payload = await request<unknown>("/api/v1/marketplace/search", {
        method: "POST",
        body: JSON.stringify({
          query: query.trim(),
          max_budget: maxBudget ? Number(maxBudget) : null,
          currency,
          location: location === "Other" ? customLocation.trim() : location,
          condition,
          sort_by: sortBy,
        }),
      });
      const response = normalizeSearchResponse(payload);
      if (!response) throw new Error("The search service did not return a product list. Please try again.");
      setResults(response.results);
      setSearchMode(response.understanding_mode || "Product matching");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not search listings.");
      setResults([]);
    } finally {
      setSearchBusy(false);
    }
  }

  async function submitSellerAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSellerBusy(true);
    setSellerError("");
    try {
      const register = sellerPage === "register";
      await request<Business>(`/api/v1/marketplace/seller/${register ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify(register ? authDraft : { email: authDraft.email, password: authDraft.password }),
      });
      await loadSeller();
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not sign in to the seller account.");
    } finally {
      setSellerBusy(false);
    }
  }

  async function saveBusiness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileBusy(true);
    setSellerError("");
    try {
      const saved = await request<Business>("/api/v1/marketplace/seller/business", {
        method: "PUT",
        body: JSON.stringify({
          business_name: authDraft.business_name,
          phone_number: authDraft.phone_number,
          location: authDraft.location,
          physical_address: authDraft.physical_address,
          legal_status: authDraft.legal_status,
          registration_details: authDraft.registration_details,
          delivery_available: authDraft.delivery_available,
          delivery_areas: authDraft.delivery_areas,
        }),
      });
      setBusiness(saved);
      setSellerError("Business details saved.");
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not save business details.");
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProductBusy(true);
    setSellerError("");
    try {
      await request<SellerProduct>(editingProductId ? `/api/v1/marketplace/seller/products/${editingProductId}` : "/api/v1/marketplace/seller/products", {
        method: editingProductId ? "PUT" : "POST",
        body: JSON.stringify({ ...productDraft, price: Number(productDraft.price), image_url: productDraft.image_url.trim() || null, active: true }),
      });
      setProductDraft(emptyProduct);
      setEditingProductId(null);
      setProducts(await request<SellerProduct[]>("/api/v1/marketplace/seller/products"));
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not add this product.");
    } finally {
      setProductBusy(false);
    }
  }

  async function uploadProductPhoto(event: FormEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const image = input.files?.[0];
    if (!image) return;
    if (image.size > 5 * 1024 * 1024) {
      setSellerError("Product photos must be 5 MB or smaller.");
      input.value = "";
      return;
    }
    setPhotoBusy(true);
    setSellerError("");
    const formData = new FormData();
    formData.append("image", image);
    try {
      const response = await fetch(`${apiBase}/api/v1/marketplace/seller/product-images`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const uploaded = await readJsonResponse<{ image_url: string }>(response, "Product photo upload");
      setProductDraft((current) => ({ ...current, image_url: uploaded.image_url }));
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not upload this photo.");
    } finally {
      setPhotoBusy(false);
      input.value = "";
    }
  }

  async function updateProduct(product: SellerProduct, patch: Partial<SellerProduct>) {
    try {
      const updated = await request<SellerProduct>(`/api/v1/marketplace/seller/products/${product.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: product.name,
          description: product.description,
          price: Number(product.price),
          currency: product.currency,
          condition: product.condition,
          image_url: product.image_url,
          in_stock: product.in_stock,
          active: product.active,
          ...patch,
        }),
      });
      setProducts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not update this listing.");
    }
  }

  async function confirmProduct(product: SellerProduct) {
    try {
      const updated = await request<SellerProduct>(`/api/v1/marketplace/seller/products/${product.id}/confirm`, { method: "POST" });
      setProducts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not confirm this listing.");
    }
  }

  async function deleteProduct(product: SellerProduct) {
    if (!window.confirm(`Delete "${product.name}"? This cannot be undone.`)) return;
    setDeletingProductId(product.id);
    setSellerError("");
    try {
      await request<void>(`/api/v1/marketplace/seller/products/${product.id}`, { method: "DELETE" });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      if (editingProductId === product.id) {
        setEditingProductId(null);
        setProductDraft(emptyProduct);
      }
      setSellerError("Product listing deleted.");
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not delete this listing.");
    } finally {
      setDeletingProductId(null);
    }
  }

  function editProduct(product: SellerProduct) {
    setEditingProductId(product.id);
    setProductDraft({
      name: product.name,
      description: product.description,
      price: product.price,
      currency: product.currency,
      condition: product.condition,
      image_url: product.image_url || "",
      in_stock: product.in_stock,
    });
  }

  async function logout() {
    setSellerBusy(true);
    setSellerError("");
    try {
      await request<void>("/api/v1/marketplace/seller/logout", { method: "POST" });
      setBusiness(emptyBusiness);
      setProducts([]);
      setSellerPage("login");
      onUnauthenticated?.();
    } catch (error) {
      setSellerError(error instanceof Error ? error.message : "Could not sign out. Please try again.");
    } finally {
      setSellerBusy(false);
    }
  }

  function switchMode(mode: ViewMode) {
    setViewMode(mode);
    setNotice("");
    setSellerError("");
  }

  return (
    <div className="marketplace-page">
      <header className="marketplace-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> ZIMBABWE / PRODUCT DISCOVERY</div>
          <h1>Smart Match<span>.</span></h1>
          <p>Find what you want. Find who sells it.</p>
        </div>
        <div className="marketplace-heading-mark"><Sparkles size={20} /><span>LOCAL<br />LISTINGS</span></div>
      </header>

      <div className="marketplace-tabs" role="tablist" aria-label="Marketplace">
        <button type="button" role="tab" aria-selected={viewMode === "search"} className={viewMode === "search" ? "selected" : ""} onClick={() => switchMode("search")}><Search size={16} />Find products</button>
        <button type="button" role="tab" aria-selected={viewMode === "seller"} className={viewMode === "seller" ? "selected" : ""} onClick={() => switchMode("seller")}><Store size={16} />Sell on ZimShop</button>
      </div>

      {viewMode === "search" ? <>
        {searchBusiness && <section className="smart-match-profile" aria-labelledby="smart-match-profile-title">
          <div className="smart-match-profile-heading"><span className="smart-match-profile-icon"><Store size={17} /></span><div><span className="eyebrow"><span className="eyebrow-line" /> YOUR ACCOUNT</span><h2 id="smart-match-profile-title">Business profile</h2></div><button type="button" className="button button-secondary" onClick={() => switchMode("seller")}>Edit profile</button></div>
          <div className="smart-match-profile-details">
            <strong>{searchBusiness.business_name}</strong>
            <span><Phone size={13} />{searchBusiness.phone_number}</span>
            <span><MapPin size={13} />{searchBusiness.location}</span>
            {searchBusiness.delivery_available && <span><Truck size={13} />Delivery available{searchBusiness.delivery_areas ? `: ${searchBusiness.delivery_areas}` : ""}</span>}
          </div>
        </section>}
        {searchProfileLoading && <div className="smart-match-profile-loading" role="status"><LoaderCircle className="spin" size={14} />Loading your business profile…</div>}
        <form className="marketplace-search" onSubmit={(event) => { event.preventDefault(); void search("best_match"); }}>
          <div className="marketplace-search-title"><div><span className="step-index">01</span><div><h2>What are you looking for?</h2><p>Describe what you need; AI helps match your request to seller and catalog products.</p></div></div><Sparkles size={17} /></div>
          <label className="field-label" htmlFor="market-query">PRODUCT OR DETAILS</label>
          <textarea id="market-query" className="market-query-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Samsung Galaxy A55, 16GB RAM laptop, school uniform..." maxLength={120} required />
          <details className="marketplace-optional-filters">
            <summary>Optional filters <span>Budget, location, and condition</span></summary>
            <div className="marketplace-filter-grid">
              <div className="market-filter-budget">
                <label className="field-label" htmlFor="market-budget">MAXIMUM BUDGET</label>
                <div><input id="market-budget" type="number" min="0" step="0.01" value={maxBudget} onChange={(event) => setMaxBudget(event.target.value)} placeholder="No limit" /><select aria-label="Budget currency" value={currency} onChange={(event) => setCurrency(event.target.value as "USD" | "ZWG")}><option value="USD">USD</option><option value="ZWG">ZWG</option></select></div>
              </div>
              <div>
                <label className="field-label" htmlFor="market-location">YOUR LOCATION</label>
                <div className="market-location-field"><MapPin size={15} /><select id="market-location" value={location} onChange={(event) => { setLocation(event.target.value); setCustomLocation(""); }}><option value="">Anywhere in Zimbabwe</option>{locations.map((item) => <option value={item} key={item}>{item}</option>)}<option value="Other">Other</option></select></div>
                {location === "Other" && <input className="market-custom-location" aria-label="Enter your town or city" value={customLocation} onChange={(event) => setCustomLocation(event.target.value)} placeholder="Enter your town or city" maxLength={120} />}
              </div>
            </div>
            <fieldset className="market-condition-field">
              <legend className="field-label">CONDITION</legend>
              <div className="market-condition-options">{(["any", "new", "used", "refurbished", "reconditioned", "grey_market"] as const).map((value) => <button key={value} type="button" aria-pressed={condition === value} className={condition === value ? "selected" : ""} onClick={() => setCondition(value)}>{value === "any" ? "Any condition" : value === "grey_market" ? "Grey market" : value[0].toUpperCase() + value.slice(1)}</button>)}</div>
            </fieldset>
          </details>
          <div className="market-search-actions">
            <button type="submit" className="button button-primary" disabled={searchBusy}>{searchBusy ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{searchBusy ? "Searching products" : "Search products"}</button>
            <button type="button" className="button button-secondary" disabled={searchBusy} onClick={() => void search("price")}><ArrowDownWideNarrow size={16} />Sort by lowest price</button>
          </div>
          {notice && <div className="marketplace-notice" role="status"><CircleAlert size={16} />{notice}</div>}
        </form>

        {searched && <section className="marketplace-results" aria-live="polite">

  
          <div className="marketplace-results-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> SMART MATCH RESULTS</span><h2>{results.length} matching {results.length === 1 ? "result" : "results"}</h2></div><span className="market-results-mode"><Sparkles size={13} />{searchMode}</span></div>
          <p className="marketplace-results-note">Results may come from registered sellers or the Bot Catalog. Seller listings include SMS and call options; Bot Catalog products show the business support phone when configured. Verify availability, price and other details with the provider before purchasing. SMS charges may apply.</p>
          {selectedProduct ? (() => {
            const product = selectedProduct;
            const isSellerListing = product.source === "marketplace";
            const customerLocation = location === "Other" ? customLocation.trim() : location;
            const phoneHref = product.phone_number?.replace(/[^\d+]/g, "") || "";
            const orderSmsHref = placeOrderSmsHref(product, customerLocation);
            const conditionLabel = formatCondition(product.condition);

            return <section className="marketplace-product-details" aria-labelledby="marketplace-product-title">
              <button type="button" className="marketplace-details-back" onClick={() => setSelectedProduct(null)}>
                <ArrowLeft size={17} /> Back to search results
              </button>
              <div className="marketplace-details-layout">
                <div className={`marketplace-details-image ${product.image_url ? "" : "image-unavailable"}`}>
                  {product.image_url
                    ? <img src={productImageUrl(product.image_url) || undefined} alt={product.product_name}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                          event.currentTarget.parentElement?.classList.add("image-unavailable");
                        }} />
                    : <><Package size={42} /><span>Product photo unavailable</span></>}
                </div>
                <div className="marketplace-details-main">
                  <div className="market-result-topline">
                    <span className={`market-source-label ${isSellerListing ? "seller" : "bot-catalog"}`}>{isSellerListing ? "Seller listing" : "Bot Catalog"}</span>
                    {isSellerListing
                      ? <span className={`market-stock ${product.in_stock ? "available" : "unconfirmed"}`}><i />{product.in_stock ? "Seller reports in stock" : "Confirm availability"}</span>
                      : <span className="market-stock unconfirmed"><i />{product.availability ? `Catalog: ${product.availability}` : "Confirm availability"}</span>}
                    {conditionLabel && <span className="market-condition-label">{conditionLabel}</span>}
                  </div>
                  <h2 id="marketplace-product-title">{product.product_name}</h2>
                  <strong className="marketplace-details-price">{formatPrice(product.price, product.currency)}</strong>
                  <div className="marketplace-details-section">
                    <h3>Product description</h3>
                    <p>{product.description || "The provider has not added a product description yet. Contact the provider to confirm specifications and included items."}</p>
                  </div>
                  <div className="marketplace-details-facts">
                    <div><span>Condition</span><strong>{conditionLabel || "Not specified"}</strong></div>
                    <div><span>Availability</span><strong>{isSellerListing ? (product.in_stock ? "Seller reports in stock" : "Please confirm with seller") : (product.availability || "Please confirm with provider")}</strong></div>
                    <div><span>Listing type</span><strong>{isSellerListing ? "Registered seller listing" : "Bot Catalog entry"}</strong></div>
                    <div><span>Last details update</span><strong>{product.details_confirmed_at ? formatDate(product.details_confirmed_at) : "Not provided"}</strong></div>
                  </div>
                  <div className="marketplace-details-section marketplace-details-business">
                    <h3><Store size={17} /> Business and seller details</h3>
                    <div className="marketplace-details-business-facts">
                      <div><span>Business</span><strong>{product.business_name || "Provider name not provided"}</strong></div>
                      <div><span>Location</span><strong>{product.location || "Location not provided"}</strong></div>
                      <div><span>Public contact</span><strong>{product.phone_number || "Phone number not provided"}</strong></div>
                    </div>
                  </div>
                  <div className="marketplace-details-section">
                    <h3><Truck size={17} /> Delivery information</h3>
                    {product.delivery_available
                      ? <p>Delivery is available{product.delivery_areas ? ` to: ${product.delivery_areas}` : ""}. Contact the business to confirm delivery fees and timing.</p>
                      : <p>{isSellerListing ? "Delivery has not been confirmed for this listing. Contact the seller to ask about collection or delivery." : "Delivery information has not been provided. Contact the provider to confirm available options."}</p>}
                  </div>
                  <p className="marketplace-details-disclaimer">
                    {isSellerListing
                      ? "Product information, price and stock are provided by the seller and have not been independently verified by ZimShop AI."
                      : "Catalog information is provided by the listed provider and has not been independently verified by ZimShop AI."}
                  </p>
                  <div className="marketplace-details-actions">
                    {orderSmsHref && <a className="market-contact-link" href={orderSmsHref}><MessageSquareText size={16} />Place order via SMS</a>}
                    {phoneHref && <a className="market-call-link" href={`tel:${phoneHref}`}><Phone size={16} />{isSellerListing ? "Call seller" : "Call provider"}</a>}
                    {!isSellerListing && product.purchase_url && <a className="market-contact-link" href={product.purchase_url} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={16} />Visit provider link</a>}
                  </div>
                </div>
              </div>
            </section>;
          })() : results.length ? <div className="marketplace-result-list">{results.map((result) => {
            const customerLocation = location === "Other" ? customLocation.trim() : location;
            const isSellerListing = result.source === "marketplace";
            const orderSmsHref = isSellerListing ? placeOrderSmsHref(result, customerLocation) : null;
            const phoneHref = result.phone_number?.replace(/[^\d+]/g, "") || "";
            const conditionLabel = formatCondition(result.condition);
            return <article
              className="marketplace-result marketplace-result-selectable"
              key={`${result.source}:${result.id}`}
              role="button"
              tabIndex={0}
              aria-label={`View full details for ${result.product_name}`}
              onClick={() => {
  console.log("PRODUCT CLICKED:", result);
  setSelectedProduct(result);
}}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedProduct(result);
                }
              }}
            >
              <div className={`market-result-image ${result.image_url ? "" : "image-unavailable"}`}>{result.image_url ? <img src={productImageUrl(result.image_url) || undefined} alt={result.product_name} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; const imageContainer = event.currentTarget.parentElement; imageContainer?.classList.add("image-unavailable"); imageContainer?.setAttribute("data-photo-error", "true"); }} /> : <><Package size={28} /><span>Product photo unavailable</span></>}</div>
              <div className="market-result-main">
                <div className="market-result-topline">
                  <span className={`market-source-label ${isSellerListing ? "seller" : "bot-catalog"}`}>{isSellerListing ? "Seller listing" : "Bot Catalog"}</span>
                  {isSellerListing
                    ? <span className={`market-stock ${result.in_stock ? "available" : "unconfirmed"}`}><i />{result.in_stock ? "Seller reports in stock" : "Confirm availability"}</span>
                    : <span className="market-stock unconfirmed"><i />{result.availability ? `Catalog: ${result.availability}` : "Confirm availability"}</span>}
                  {conditionLabel && <span className="market-condition-label">{conditionLabel}</span>}
                </div>
                <h3>{result.product_name}</h3>
                <p className="market-result-description">{result.description || "No extra details provided."}</p>
                {isSellerListing && result.business_name && <div className="market-result-business"><Store size={15} /><strong>{result.business_name}</strong>{result.location && <span><MapPin size={13} />{result.location}</span>}</div>}
                {!isSellerListing && result.phone_number && <div className="market-result-business"><Phone size={14} /><strong>Contact: {result.phone_number}</strong></div>}
                {isSellerListing && result.delivery_available && <div className="market-delivery-note"><Truck size={14} />Delivery available{result.delivery_areas ? `: ${result.delivery_areas}` : ""}</div>}
                <div className="market-match-reasons">{result.match_reasons.map((reason) => <span key={reason}><Check size={12} />{reason}</span>)}</div>
                <small className="market-updated">{isSellerListing
                  ? <>Seller confirmed price and stock {formatDate(result.details_confirmed_at)} · not independently verified</>
                  : <>Catalog entry added {formatDate(result.details_confirmed_at)} · details not independently verified</>}</small>
              </div>
              <div className="market-result-side">
                <strong className="market-result-price">{formatPrice(result.price, result.currency)}</strong>
                <button
                  type="button"
                  className="market-view-details-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedProduct(result);
                  }}
                >
                  View full details <ArrowUpRight size={14} />
                </button>
                {isSellerListing && maxBudget && currency === result.currency && <span className="market-budget-badge">Within budget</span>}
                {orderSmsHref && <a className="market-contact-link" href={orderSmsHref} onClick={(event) => event.stopPropagation()}><MessageSquareText size={15} />Place Order via SMS</a>}
                {phoneHref && <a className="market-call-link" href={`tel:${phoneHref}`} onClick={(event) => event.stopPropagation()}><Phone size={15} />{isSellerListing ? "Call seller" : "Call provider"}</a>}
                {!isSellerListing && result.purchase_url && <a className="market-contact-link" href={result.purchase_url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}><ArrowUpRight size={15} />View provider link</a>}
              </div>
            </article>;
          })}</div> : <div className="marketplace-no-results"><ShoppingBag size={25} /><div><strong>No matching products found.</strong><p>Try a shorter product name, a higher budget, or a wider location.</p><span>Matching seller listings and Bot Catalog entries can appear here.</span></div></div>}
        </section>}
        {!searched && <div className="marketplace-trust-note"><BadgeCheck size={16} /><span>Results may come from seller listings or the Bot Catalog. ZimShop AI does not independently confirm availability or guarantee prices.</span></div>}
      </> : <section className="seller-area">
        {sellerPage === "dashboard" && business.id ? <>
          <div className="seller-dashboard-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> SELLER WORKSPACE</span><h2>{business.business_name}</h2><p><MapPin size={14} />{business.location} <span>·</span> Seller profile</p></div><button type="button" className="icon-button" title="Sign out" aria-label="Sign out" onClick={() => void logout()} disabled={sellerBusy}><LogOut size={16} /></button></div>
          <div className="seller-status-note"><BadgeCheck size={16} /><span>Listings are public and seller-provided. Add accurate prices, photos and stock, and update them when details change.</span></div>
          {sellerError && <div className="marketplace-notice" role="status"><CircleAlert size={16} />{sellerError}</div>}
          <div className="seller-dashboard-grid">
            <form className="seller-form" onSubmit={saveBusiness}>
              <div className="seller-form-heading"><Store size={17} /><h3>Business details</h3></div>
              <label className="field-label" htmlFor="seller-business-name">BUSINESS NAME</label><input id="seller-business-name" className="text-input" value={authDraft.business_name} onChange={(event) => setAuthDraft((current) => ({ ...current, business_name: event.target.value }))} required maxLength={200} />
              <label className="field-label" htmlFor="seller-phone">CUSTOMER CONTACT</label><input id="seller-phone" className="text-input" type="tel" value={authDraft.phone_number} onChange={(event) => setAuthDraft((current) => ({ ...current, phone_number: event.target.value }))} required maxLength={40} />
              <label className="field-label" htmlFor="seller-location">SHOP LOCATION</label><input id="seller-location" className="text-input" list="seller-locations" value={authDraft.location} onChange={(event) => setAuthDraft((current) => ({ ...current, location: event.target.value }))} required maxLength={120} /><datalist id="seller-locations">{locations.map((item) => <option value={item} key={item} />)}</datalist>
              <label className="field-label" htmlFor="seller-physical-address">PHYSICAL BUSINESS ADDRESS</label><textarea id="seller-physical-address" className="node-body-input" value={authDraft.physical_address} onChange={(event) => setAuthDraft((current) => ({ ...current, physical_address: event.target.value }))} required minLength={5} maxLength={500} placeholder="Street address and suburb (not shown in public listings)" />
              <label className="field-label" htmlFor="seller-legal-status">LEGAL STATUS</label><select id="seller-legal-status" className="text-input" value={authDraft.legal_status} onChange={(event) => setAuthDraft((current) => ({ ...current, legal_status: event.target.value }))}><option value="individual">Individual</option><option value="sole_proprietor">Sole proprietor</option><option value="partnership">Partnership</option><option value="company">Company</option><option value="other">Other</option></select>
              <label className="field-label" htmlFor="seller-registration-details">REGISTRATION DETAILS (IF APPLICABLE)</label><input id="seller-registration-details" className="text-input" value={authDraft.registration_details} onChange={(event) => setAuthDraft((current) => ({ ...current, registration_details: event.target.value }))} maxLength={200} placeholder="Registration number or details" />
              <label className="seller-delivery-toggle"><input type="checkbox" checked={authDraft.delivery_available} onChange={(event) => setAuthDraft((current) => ({ ...current, delivery_available: event.target.checked }))} /><span><strong>We offer delivery</strong><small>Show this to buyers searching nearby.</small></span></label>
              {authDraft.delivery_available && <><label className="field-label" htmlFor="seller-delivery-areas">DELIVERY AREAS</label><input id="seller-delivery-areas" className="text-input" value={authDraft.delivery_areas} onChange={(event) => setAuthDraft((current) => ({ ...current, delivery_areas: event.target.value }))} placeholder="Harare, Chitungwiza" maxLength={1000} /></>}
              <button className="button button-secondary" type="submit" disabled={profileBusy}>{profileBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save business details</button>
            </form>
            <div className="seller-product-column">
              <form className="seller-form" onSubmit={saveProduct}>
                <div className="seller-form-heading">{editingProductId ? <Pencil size={17} /> : <Plus size={17} />}<h3>{editingProductId ? "Edit product" : "Add a product"}</h3></div>
                <label className="field-label" htmlFor="listing-name">PRODUCT NAME</label><input id="listing-name" className="text-input" value={productDraft.name} onChange={(event) => setProductDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Samsung Galaxy A55" required maxLength={120} />
                <label className="field-label" htmlFor="listing-description">PRODUCT DETAILS AND ADDITIONAL CHARGES</label><textarea id="listing-description" className="node-body-input" value={productDraft.description} onChange={(event) => setProductDraft((current) => ({ ...current, description: event.target.value }))} placeholder="Storage, size, colour, model, and any mandatory delivery fees, taxes or other charges..." rows={2} maxLength={1000} />
                <div className="marketplace-filter-grid"><div><label className="field-label" htmlFor="listing-price">PRICE</label><input id="listing-price" className="text-input" type="number" min="0.01" step="0.01" value={productDraft.price} onChange={(event) => setProductDraft((current) => ({ ...current, price: event.target.value }))} required /></div><div><label className="field-label" htmlFor="listing-currency">CURRENCY</label><select id="listing-currency" className="text-input" value={productDraft.currency} onChange={(event) => setProductDraft((current) => ({ ...current, currency: event.target.value as "USD" | "ZWG" }))}><option value="USD">USD</option><option value="ZWG">ZWG</option></select></div></div>
                <div className="marketplace-filter-grid"><div><label className="field-label" htmlFor="listing-condition">CONDITION</label><select id="listing-condition" className="text-input" value={productDraft.condition} onChange={(event) => setProductDraft((current) => ({ ...current, condition: event.target.value as SellerProduct["condition"] }))}><option value="new">New</option><option value="used">Used</option><option value="refurbished">Refurbished</option><option value="reconditioned">Reconditioned</option><option value="grey_market">Grey market</option></select></div><div><label className="field-label" htmlFor="listing-image-file">UPLOAD PHOTO FROM THIS DEVICE</label><input id="listing-image-file" className="text-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadProductPhoto(event)} disabled={photoBusy} />{photoBusy && <small className="seller-photo-status">Uploading photo…</small>}{productDraft.image_url && <img className="seller-product-preview" src={productImageUrl(productDraft.image_url) || undefined} alt="Product photo preview" />}</div></div>
                <label className="field-label" htmlFor="listing-image-url">OR ENTER A PHOTO URL (OPTIONAL)</label><input id="listing-image-url" className="text-input" type="url" value={productDraft.image_url.startsWith("/") ? "" : productDraft.image_url} onChange={(event) => setProductDraft((current) => ({ ...current, image_url: event.target.value }))} placeholder="https://..." maxLength={1000} />
                <small className="seller-photo-status">Use a photo from your device or enter a photo URL. You do not need to provide both.</small>
                <label className="seller-delivery-toggle"><input type="checkbox" checked={productDraft.in_stock} onChange={(event) => setProductDraft((current) => ({ ...current, in_stock: event.target.checked }))} /><span><strong>Seller reports in stock</strong><small>Buyers are always asked to confirm availability.</small></span></label>
                <div className="seller-product-form-actions"><button className="button button-primary" type="submit" disabled={productBusy || photoBusy}>{productBusy ? <LoaderCircle className="spin" size={15} /> : editingProductId ? <Check size={15} /> : <Plus size={15} />}{photoBusy ? "Uploading photo" : editingProductId ? "Save listing" : "Publish listing"}</button>{editingProductId && <button className="button button-secondary" type="button" disabled={photoBusy} onClick={() => { setEditingProductId(null); setProductDraft(emptyProduct); }}><X size={14} />Cancel</button>}</div>
              </form>
              <div className="seller-listings"><div className="seller-listings-heading"><h3>Your listings</h3><span>{products.length} PRODUCTS</span></div>
                {products.length ? products.map((product) => <article className={`seller-listing-row ${product.active ? "" : "paused"}`} key={product.id}><div className="seller-listing-photo">{product.image_url ? <img src={productImageUrl(product.image_url) || undefined} alt="" loading="lazy" /> : <Camera size={17} />}</div><div className="seller-listing-copy"><strong>{product.name}</strong><span>{formatPrice(product.price, product.currency)} · {formatCondition(product.condition)} · {product.in_stock ? "In stock" : "Out of stock"}</span><small>Confirmed {formatDate(product.details_confirmed_at)}</small></div><button type="button" className="icon-button" title="Edit listing" aria-label={`Edit ${product.name}`} onClick={() => editProduct(product)}><Pencil size={14} /></button><button type="button" className="icon-button" title="Confirm price and stock" aria-label={`Confirm price and stock: ${product.name}`} onClick={() => void confirmProduct(product)}><Check size={15} /></button><button type="button" className="icon-button" title={product.in_stock ? "Mark out of stock" : "Mark in stock"} aria-label={`${product.in_stock ? "Mark out of stock" : "Mark in stock"}: ${product.name}`} onClick={() => void updateProduct(product, { in_stock: !product.in_stock })}>{product.in_stock ? <Check size={15} /> : <Package size={15} />}</button><button type="button" className="icon-button" title={product.active ? "Pause listing" : "Publish listing"} aria-label={`${product.active ? "Pause" : "Publish"}: ${product.name}`} onClick={() => void updateProduct(product, { active: !product.active })}>{product.active ? <Pause size={15} /> : <Play size={15} />}</button><button type="button" className="icon-button delete-product-button" title="Delete listing" aria-label={`Delete ${product.name}`} disabled={deletingProductId === product.id} onClick={() => void deleteProduct(product)}>{deletingProductId === product.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></article>) : <div className="seller-listings-empty"><Package size={20} /><p>Your product listings will appear here.</p></div>}
              </div>
            </div>
          </div>
        </> : <div className="seller-auth-layout">
          <div className="seller-auth-intro"><span className="eyebrow"><span className="eyebrow-line" /> SELLER ACCESS</span><h2>{sellerPage === "register" ? "Put your products in front of local buyers." : "Manage your shop listings."}</h2><p>Seller registration is free. Buyers can discover your products, compare listed prices and contact your business directly.</p><div className="seller-benefit"><Check size={15} />Reach buyers searching by budget and location</div><div className="seller-benefit"><Check size={15} />Manage your own products, prices and stock</div><div className="seller-benefit"><Check size={15} />Listings display as seller-reported</div><a className="seller-auth-switch" href="/">Browse Smart Match without signing in <ArrowUpRight size={14} /></a></div>
          <form className="seller-form seller-auth-form" onSubmit={submitSellerAuth}>
            <div className="seller-form-heading">{sellerPage === "register" ? <UserPlus size={17} /> : <LogIn size={17} />}<h3>{sellerPage === "register" ? "Create a seller account" : "Seller sign in"}</h3></div>
            {sellerError && <div className="marketplace-notice" role="status"><CircleAlert size={16} />{sellerError}</div>}
            {sellerPage === "register" && <>
              <label className="field-label" htmlFor="register-business">BUSINESS NAME</label><input id="register-business" className="text-input" value={authDraft.business_name} onChange={(event) => setAuthDraft((current) => ({ ...current, business_name: event.target.value }))} required minLength={2} maxLength={200} />
              <label className="field-label" htmlFor="register-phone">CONTACT PHONE</label><input id="register-phone" className="text-input" type="tel" value={authDraft.phone_number} onChange={(event) => setAuthDraft((current) => ({ ...current, phone_number: event.target.value }))} required maxLength={40} />
              <label className="field-label" htmlFor="register-location">SHOP LOCATION</label><input id="register-location" className="text-input" list="register-locations" value={authDraft.location} onChange={(event) => setAuthDraft((current) => ({ ...current, location: event.target.value }))} required maxLength={120} /><datalist id="register-locations">{locations.map((item) => <option value={item} key={item} />)}</datalist>
              <label className="field-label" htmlFor="register-address">PHYSICAL BUSINESS ADDRESS</label><textarea id="register-address" className="node-body-input" value={authDraft.physical_address} onChange={(event) => setAuthDraft((current) => ({ ...current, physical_address: event.target.value }))} required minLength={5} maxLength={500} placeholder="Street address and suburb (not shown in public listings)" />
              <label className="field-label" htmlFor="register-legal-status">LEGAL STATUS</label><select id="register-legal-status" className="text-input" value={authDraft.legal_status} onChange={(event) => setAuthDraft((current) => ({ ...current, legal_status: event.target.value }))}><option value="individual">Individual</option><option value="sole_proprietor">Sole proprietor</option><option value="partnership">Partnership</option><option value="company">Company</option><option value="other">Other</option></select>
              <label className="field-label" htmlFor="register-registration-details">REGISTRATION DETAILS (IF APPLICABLE)</label><input id="register-registration-details" className="text-input" value={authDraft.registration_details} onChange={(event) => setAuthDraft((current) => ({ ...current, registration_details: event.target.value }))} maxLength={200} placeholder="Registration number or details" />
              <label className="seller-delivery-toggle"><input type="checkbox" checked={authDraft.delivery_available} onChange={(event) => setAuthDraft((current) => ({ ...current, delivery_available: event.target.checked }))} /><span><strong>We offer delivery</strong><small>Specify the towns or cities you deliver to.</small></span></label>
              {authDraft.delivery_available && <><label className="field-label" htmlFor="register-delivery-areas">DELIVERY AREAS</label><input id="register-delivery-areas" className="text-input" value={authDraft.delivery_areas} onChange={(event) => setAuthDraft((current) => ({ ...current, delivery_areas: event.target.value }))} placeholder="Harare, Chitungwiza" maxLength={1000} /></>}
            </>}
            <label className="field-label" htmlFor="seller-email">EMAIL</label><input id="seller-email" className="text-input" type="email" autoComplete="email" value={authDraft.email} onChange={(event) => setAuthDraft((current) => ({ ...current, email: event.target.value }))} required maxLength={320} />
            <label className="field-label" htmlFor="seller-password">PASSWORD</label><input id="seller-password" className="text-input" type="password" autoComplete={sellerPage === "register" ? "new-password" : "current-password"} value={authDraft.password} onChange={(event) => setAuthDraft((current) => ({ ...current, password: event.target.value }))} required minLength={sellerPage === "register" ? 10 : 1} maxLength={128} />
            {sellerPage === "register" && <label className="seller-delivery-toggle"><input type="checkbox" checked={authDraft.terms_accepted} onChange={(event) => setAuthDraft((current) => ({ ...current, terms_accepted: event.target.checked }))} required /><span><strong>I agree to the <a href="/terms/" target="_blank" rel="noreferrer">Terms and Conditions</a> and acknowledge the <a href="/privacy/" target="_blank" rel="noreferrer">Privacy Policy</a>.</strong><small>We record the terms version and acceptance time with your account.</small></span></label>}
            <button className="button button-primary" type="submit" disabled={sellerBusy}>{sellerBusy ? <LoaderCircle className="spin" size={15} /> : sellerPage === "register" ? <UserPlus size={15} /> : <LogIn size={15} />}{sellerPage === "register" ? "Create free seller account" : "Sign in"}</button>
            <button type="button" className="seller-auth-switch" onClick={() => { setSellerPage(sellerPage === "register" ? "login" : "register"); setSellerError(""); }}>{sellerPage === "register" ? "Already have an account? Sign in" : "New to ZimShop? Create a free seller account"}<ArrowUpRight size={14} /></button>
          </form>
        </div>}
      </section>}
    </div>
  );
}
