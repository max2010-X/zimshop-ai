const productionApiUrl = "https://zimshop-ai.onrender.com";

export const apiBase = (
  import.meta.env.VITE_API_URL || (import.meta.env.PROD ? productionApiUrl : "")
).replace(/\/$/, "");
