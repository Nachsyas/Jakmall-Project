import React from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { Navigation } from "./components/Navigation.js";
import { Footer } from "./components/Footer.js";
import { HomePage } from "./pages/HomePage.js";
import { ProductsPage } from "./pages/ProductsPage.js";
import { ProductDetailPage } from "./pages/ProductDetailPage.js";
import { SyncPage } from "./pages/SyncPage.js";
import { ReviewsPage } from "./pages/ReviewsPage.js";
import { ActivityPage } from "./pages/ActivityPage.js";

const NotFoundPage: React.FC = () => {
  return (
    <main className="section-full section-light" style={{ minHeight: "70vh", textAlign: "center", paddingTop: "var(--spacing-3xl)" }}>
      <div className="container" style={{ maxWidth: "560px" }}>
        <h1 style={{ fontSize: "var(--font-size-headline)", marginBottom: "var(--spacing-sm)" }}>
          Page Not Found
        </h1>
        <p style={{ color: "var(--color-muted)", marginBottom: "var(--spacing-xl)" }}>
          The page you are looking for does not exist in Intelligent Commerce Sync.
        </p>
        <Link to="/" className="btn btn-primary">
          Return to Overview
        </Link>
      </div>
    </main>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <Navigation />
        <div style={{ flexGrow: 1 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/products/:id" element={<ProductDetailPage />} />
            <Route path="/sync" element={<SyncPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
        <Footer />
      </div>
    </BrowserRouter>
  );
};

export default App;
