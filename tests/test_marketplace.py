import unittest
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from backend.app.database import Base, get_session
from backend.app import marketplace
from backend.app.marketplace import _hash_password, _verify_password, match_marketplace_products, parse_marketplace_query, router
from backend.app.migrations import migrate_bot_product_image_schema, migrate_marketplace_terms_schema
from backend.app.models import BotBusinessProfile, BotProduct, MarketplaceSearchQuery, StoredProductImage
from backend.app.schemas import BotProductCreate, MarketplaceSearchRequest


class MarketplaceTermsMigrationTests(unittest.TestCase):
    def test_existing_marketplace_tables_receive_terms_and_business_fields(self):
        engine = create_engine("sqlite://")
        with engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE users (id TEXT PRIMARY KEY)")
            connection.exec_driver_sql("CREATE TABLE marketplace_businesses (id TEXT PRIMARY KEY)")
            connection.exec_driver_sql("CREATE TABLE marketplace_products (id TEXT PRIMARY KEY, condition VARCHAR(8))")

        migrate_marketplace_terms_schema(engine)

        self.assertIn("terms_accepted_at", {column["name"] for column in inspect(engine).get_columns("users")})
        business_columns = {column["name"] for column in inspect(engine).get_columns("marketplace_businesses")}
        self.assertTrue({"physical_address", "legal_status", "registration_details"}.issubset(business_columns))
        engine.dispose()

    def test_existing_bot_catalog_table_receives_product_image_column(self):
        engine = create_engine("sqlite://")
        with engine.begin() as connection:
            connection.exec_driver_sql("CREATE TABLE bot_products (id TEXT PRIMARY KEY)")
            connection.exec_driver_sql("CREATE TABLE bot_business_profiles (id INTEGER PRIMARY KEY)")

        migrate_bot_product_image_schema(engine)

        self.assertIn("image_url", {column["name"] for column in inspect(engine).get_columns("bot_products")})
        self.assertIn("query_retention_days", {column["name"] for column in inspect(engine).get_columns("bot_business_profiles")})
        engine.dispose()


class MarketplaceMatchingTests(unittest.TestCase):
    def setUp(self):
        self.confirmed_at = datetime(2026, 11, 6, tzinfo=timezone.utc)
        self.harare_business = SimpleNamespace(
            id="business-harare",
            business_name="Harare Mobile Shop",
            phone_number="+263771234567",
            location="Harare",
            delivery_available=False,
            delivery_areas="",
            active=True,
            updated_at=self.confirmed_at,
        )
        self.delivery_business = SimpleNamespace(
            id="business-delivery",
            business_name="Citywide Phones",
            phone_number="+263772222222",
            location="Bulawayo",
            delivery_available=True,
            delivery_areas="Harare, Chitungwiza",
            active=True,
            updated_at=self.confirmed_at,
        )
        self.harare_product = SimpleNamespace(
            id="product-harare",
            name="Samsung Galaxy A55 5G",
            description="256GB Android smartphone",
            price=Decimal("280.00"),
            currency="USD",
            condition="new",
            image_url=None,
            in_stock=True,
            active=True,
            details_confirmed_at=self.confirmed_at,
            updated_at=self.confirmed_at,
        )
        self.delivery_product = SimpleNamespace(
            id="product-delivery",
            name="Samsung Galaxy A55",
            description="128GB phone",
            price=Decimal("295.00"),
            currency="USD",
            condition="new",
            image_url=None,
            in_stock=True,
            active=True,
            details_confirmed_at=self.confirmed_at,
            updated_at=self.confirmed_at,
        )

    def test_search_filters_budget_condition_and_location_and_ranks_local_seller(self):
        request = MarketplaceSearchRequest(
            query="Samsung Galaxy A55",
            max_budget=Decimal("300.00"),
            currency="USD",
            location="Harare",
            condition="new",
        )

        results = match_marketplace_products(request, [
            (self.delivery_product, self.delivery_business),
            (self.harare_product, self.harare_business),
        ])

        self.assertEqual([result["business_name"] for result in results], ["Harare Mobile Shop", "Citywide Phones"])
        self.assertIn("Within budget", results[0]["match_reasons"])
        self.assertIn("Located in Harare", results[0]["match_reasons"])
        self.assertIn("Delivers to Harare", results[1]["match_reasons"])

    def test_budget_and_condition_remove_nonmatching_listings(self):
        used_product = SimpleNamespace(**{**vars(self.harare_product), "condition": "used"})
        expensive_product = SimpleNamespace(**{**vars(self.delivery_product), "price": Decimal("450.00")})
        request = MarketplaceSearchRequest(
            query="Samsung A55",
            max_budget=Decimal("300.00"),
            currency="USD",
            location="Harare",
            condition="new",
        )

        results = match_marketplace_products(request, [
            (used_product, self.harare_business),
            (expensive_product, self.delivery_business),
        ])

        self.assertEqual(results, [])

    def test_delivery_without_declared_areas_does_not_match_everywhere(self):
        business_without_areas = SimpleNamespace(**{**vars(self.delivery_business), "delivery_areas": ""})
        request = MarketplaceSearchRequest(query="Samsung A55", location="Harare")

        results = match_marketplace_products(request, [(self.delivery_product, business_without_areas)])

        self.assertEqual(results, [])

    def test_cheapest_sort_orders_matching_products_by_price(self):
        request = MarketplaceSearchRequest(query="Samsung A55", sort_by="price")

        results = match_marketplace_products(request, [
            (self.delivery_product, self.delivery_business),
            (self.harare_product, self.harare_business),
        ])

        self.assertEqual([result["price"] for result in results], ["280.00", "295.00"])

    def test_product_query_alone_matches_seller_and_bot_catalog_results(self):
        request = MarketplaceSearchRequest(query="Samsung Galaxy A55")
        catalog_product = SimpleNamespace(
            id="catalog-product",
            name="Samsung Galaxy A55",
            description="Android smartphone",
            price="USD 250",
            availability="Available",
            image_url=None,
            purchase_url=None,
            interests=["smartphones"],
            active=True,
            created_at=self.confirmed_at,
        )

        results = match_marketplace_products(
            request,
            [(self.harare_product, self.harare_business)],
            [catalog_product],
        )

        self.assertEqual(request.max_budget, None)
        self.assertEqual(request.location, "")
        self.assertEqual(request.condition, "any")
        self.assertEqual(
            {result["source"] for result in results},
            {"marketplace", "bot_catalog"},
        )

    def test_seller_password_hash_is_salted_and_verified(self):
        first_hash = _hash_password("correct-horse-battery")
        second_hash = _hash_password("correct-horse-battery")

        self.assertNotEqual(first_hash, second_hash)
        self.assertTrue(_verify_password("correct-horse-battery", first_hash))
        self.assertFalse(_verify_password("wrong-password", first_hash))

    def test_bot_catalog_results_are_excluded_when_unverified_filters_are_used(self):
        catalog_product = SimpleNamespace(
            id="catalog-product-1",
            name="Samsung Galaxy A55",
            description="Android smartphone",
            price="250",
            availability="Available",
            image_url=None,
            purchase_url=None,
            interests=["smartphones"],
            active=True,
            created_at=self.confirmed_at,
        )

        normal_request = MarketplaceSearchRequest(query="Samsung Galaxy A55")
        normal_results = match_marketplace_products(
            normal_request, [], [catalog_product]
        )
        self.assertEqual(len(normal_results), 1)
        self.assertEqual(normal_results[0]["source"], "bot_catalog")

        filtered_requests = [
            MarketplaceSearchRequest(
                query="Samsung Galaxy A55",
                max_budget=Decimal("300.00"),
                currency="USD",
            ),
            MarketplaceSearchRequest(
                query="Samsung Galaxy A55",
                location="Harare",
            ),
            MarketplaceSearchRequest(
                query="Samsung Galaxy A55",
                condition="new",
            ),
        ]

        for request in filtered_requests:
            with self.subTest(request=request):
                results = match_marketplace_products(
                    request, [], [catalog_product]
                )
                self.assertEqual(results, [])

    def test_natural_language_query_uses_ai_catalog_terms(self):
        from unittest.mock import patch

        with patch("backend.app.marketplace.generate_ai_json", return_value=(
            {"keywords": ["laptop", "core i7", "16gb ram"]}, "Cloudflare AI",
        )):
            query, mode = parse_marketplace_query("I need a Core i7 laptop with 16GB RAM")

        self.assertEqual(query, "laptop core i7 16gb ram")
        self.assertEqual(mode, "Cloudflare AI")


class MarketplaceApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False)
        test_app = FastAPI()
        test_app.include_router(router)

        def override_get_session():
            with self.session_factory() as session:
                yield session

        test_app.dependency_overrides[get_session] = override_get_session
        self.client = TestClient(test_app, base_url="https://testserver")
        self.environment = patch.dict("os.environ", {"APP_ENV": "development"}, clear=False)
        self.environment.start()

    def tearDown(self):
        self.client.close()
        self.environment.stop()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_seller_registers_lists_product_and_public_search_returns_real_listing(self):
        seller = self.client.post("/api/v1/marketplace/seller/register", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
            "business_name": "Harare Tech",
            "phone_number": "+263771234567",
            "location": "Harare",
            "physical_address": "12 Example Road, Harare",
            "legal_status": "company",
            "registration_details": "Company registration 12345/2020",
            "terms_accepted": True,
            "delivery_available": True,
            "delivery_areas": "Harare, Chitungwiza",
        })
        self.assertEqual(seller.status_code, 201, seller.text)

        created = self.client.post("/api/v1/marketplace/seller/products", json={
            "name": "Samsung Galaxy A55",
            "description": "256GB smartphone",
            "price": "280.00",
            "currency": "USD",
            "condition": "new",
            "in_stock": True,
        })
        self.assertEqual(created.status_code, 201, created.text)
        confirmed_at = created.json()["details_confirmed_at"]

        paused = self.client.put(f"/api/v1/marketplace/seller/products/{created.json()['id']}", json={
            "name": "Samsung Galaxy A55",
            "description": "256GB smartphone",
            "price": "280.00",
            "currency": "USD",
            "condition": "new",
            "in_stock": True,
            "active": False,
        })
        self.assertEqual(paused.status_code, 200, paused.text)
        self.assertEqual(paused.json()["details_confirmed_at"], confirmed_at)

        confirmed = self.client.post(f"/api/v1/marketplace/seller/products/{created.json()['id']}/confirm")
        self.assertEqual(confirmed.status_code, 200, confirmed.text)

        restored = self.client.put(f"/api/v1/marketplace/seller/products/{created.json()['id']}", json={
            "name": "Samsung Galaxy A55",
            "description": "256GB smartphone",
            "price": "280.00",
            "currency": "USD",
            "condition": "new",
            "in_stock": True,
            "active": True,
        })
        self.assertEqual(restored.status_code, 200, restored.text)

        with patch("backend.app.marketplace.generate_ai_json", return_value=(None, None)):
            response = self.client.post("/api/v1/marketplace/search", json={
                "query": "Samsung Galaxy A55",
                "max_budget": "300.00",
                "currency": "USD",
                "location": "Harare",
                "condition": "new",
            })

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(len(payload["results"]), 1)
        self.assertEqual(payload["results"][0]["business_name"], "Harare Tech")
        self.assertEqual(payload["results"][0]["price"], "280.00")
        self.assertEqual(payload["results"][0]["source"], "marketplace")
        self.assertIn("Seller listing; verify details before paying", payload["results"][0]["match_reasons"])

    def test_search_includes_bot_catalog_without_inventing_seller_details(self):
        catalog_product = BotProduct(
            name="Samsung Galaxy A55",
            description="256GB smartphone",
            price="USD 280",
            availability="Available",
            image_url="/uploads/0123456789abcdef0123456789abcdef.png",
            purchase_url="https://example.com/products/a55",
            interests=["smartphone"],
            active=True,
        )
        with self.session_factory() as session:
            session.add(catalog_product)
            session.commit()

        with patch("backend.app.marketplace.generate_ai_json", return_value=(
            {"keywords": ["Galaxy A55"]}, "Test AI",
        )):
            response = self.client.post("/api/v1/marketplace/search", json={
                "query": "I want a Samsung",
            })

        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["results"][0]
        self.assertEqual(result["source"], "bot_catalog")
        self.assertEqual(result["product_name"], "Samsung Galaxy A55")
        self.assertEqual(result["price"], "USD 280")
        self.assertEqual(result["availability"], "Available")
        self.assertEqual(result["image_url"], "/uploads/0123456789abcdef0123456789abcdef.png")
        self.assertEqual(result["purchase_url"], "https://example.com/products/a55")
        self.assertIsNone(result["currency"])
        self.assertIsNone(result["condition"])
        self.assertIsNone(result["in_stock"])
        self.assertIsNone(result["business_name"])
        self.assertIsNone(result["phone_number"])
        self.assertIsNone(result["location"])

    def test_search_query_is_saved_without_customer_contact_details_or_filters(self):
        with patch("backend.app.marketplace.generate_ai_json", return_value=(None, None)):
            response = self.client.post("/api/v1/marketplace/search", json={
                "query": "Samsung Galaxy A55",
                "location": "Harare",
                "max_budget": "300.00",
            })

        self.assertEqual(response.status_code, 200, response.text)
        with self.session_factory() as session:
            saved_query = session.query(MarketplaceSearchQuery).one()
            self.assertEqual(saved_query.query, "Samsung Galaxy A55")
            self.assertEqual(saved_query.result_count, 0)
            self.assertFalse(hasattr(saved_query, "location"))

    def test_query_retention_deletes_expired_records_and_supports_never(self):
        expired = MarketplaceSearchQuery(
            query="Expired query",
            result_count=0,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        current = MarketplaceSearchQuery(
            query="Recent query",
            result_count=1,
        )
        with self.session_factory() as session:
            session.add_all([
                BotBusinessProfile(id=1, query_retention_days=7),
                expired,
                current,
            ])
            session.commit()
            self.assertEqual(marketplace.purge_expired_search_queries(session), 1)
            session.commit()
            self.assertEqual(
                [item.query for item in session.query(MarketplaceSearchQuery).all()],
                ["Recent query"],
            )
            profile = session.get(BotBusinessProfile, 1)
            profile.query_retention_days = None
            session.add(MarketplaceSearchQuery(
                query="Keep forever",
                result_count=0,
                created_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
            ))
            session.commit()
            self.assertEqual(marketplace.purge_expired_search_queries(session), 0)

    def test_ai_expanded_search_terms_match_related_catalog_products(self):
        catalog_product = BotProduct(
            name="Running shoes",
            description="Lightweight footwear for exercise",
            price="USD 45",
            availability="Available",
            interests=["sneakers", "trainers"],
            active=True,
        )
        with self.session_factory() as session:
            session.add(catalog_product)
            session.commit()

        with patch("backend.app.marketplace.generate_ai_json", return_value=(
            {"keywords": ["sneakers", "running shoes", "trainers"]}, "Test AI",
        )):
            response = self.client.post("/api/v1/marketplace/search", json={"query": "sneakers"})

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["understanding_mode"], "Test AI")
        self.assertEqual(payload["results"][0]["product_name"], "Running shoes")

    def test_bot_catalog_search_includes_configured_support_phone(self):
        catalog_product = BotProduct(
            name="Running shoes",
            description="Lightweight footwear for exercise",
            price="USD 45",
            availability="Available",
            interests=["sneakers", "trainers"],
            active=True,
        )
        with self.session_factory() as session:
            session.add(BotBusinessProfile(id=1, support_contact="+263 77 123 4567"))
            session.add(catalog_product)
            session.commit()

        with patch("backend.app.marketplace.generate_ai_json", return_value=(None, None)):
            response = self.client.post("/api/v1/marketplace/search", json={"query": "sneakers"})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["results"][0]["phone_number"], "+263 77 123 4567")


    def test_seller_registration_requires_terms_acceptance(self):
        response = self.client.post("/api/v1/marketplace/seller/register", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
            "business_name": "Harare Tech",
            "phone_number": "+263771234567",
            "location": "Harare",
            "physical_address": "12 Example Road, Harare",
            "legal_status": "company",
            "terms_accepted": False,
        })

        self.assertEqual(response.status_code, 422)

    def test_seller_listing_routes_require_a_session(self):
        response = self.client.get("/api/v1/marketplace/seller/products")

        self.assertEqual(response.status_code, 401)

    def test_seller_can_delete_own_listing(self):
        registration = self.client.post("/api/v1/marketplace/seller/register", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
            "business_name": "Harare Tech",
            "phone_number": "+263771234567",
            "location": "Harare",
            "physical_address": "12 Example Road, Harare",
            "legal_status": "individual",
            "terms_accepted": True,
        })
        self.assertEqual(registration.status_code, 201, registration.text)
        created = self.client.post("/api/v1/marketplace/seller/products", json={
            "name": "Samsung Galaxy A55",
            "price": "280.00",
        })
        self.assertEqual(created.status_code, 201, created.text)

        deleted = self.client.delete(f"/api/v1/marketplace/seller/products/{created.json()['id']}")

        self.assertEqual(deleted.status_code, 204, deleted.text)
        self.assertEqual(self.client.get("/api/v1/marketplace/seller/products").json(), [])
        missing = self.client.delete(f"/api/v1/marketplace/seller/products/{created.json()['id']}")
        self.assertEqual(missing.status_code, 404)

    def test_seller_can_log_back_in_and_upload_a_product_photo(self):
        registration = self.client.post("/api/v1/marketplace/seller/register", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
            "business_name": "Harare Tech",
            "phone_number": "+263771234567",
            "location": "Harare",
            "physical_address": "12 Example Road, Harare",
            "legal_status": "company",
            "registration_details": "Company registration 12345/2020",
            "terms_accepted": True,
        })
        self.assertEqual(registration.status_code, 201, registration.text)
        with self.session_factory() as session:
            from backend.app.models import User
            user = session.query(User).filter_by(email="seller@example.co.zw").one()
            self.assertIsNotNone(user.terms_accepted_at)
            self.assertEqual(user.terms_version, "2026-11-13")
        self.client.post("/api/v1/marketplace/seller/logout")
        self.assertEqual(self.client.get("/api/v1/marketplace/seller/account").status_code, 401)

        login = self.client.post("/api/v1/marketplace/seller/login", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
        })
        self.assertEqual(login.status_code, 200, login.text)

        upload = self.client.post(
            "/api/v1/marketplace/seller/product-images",
            files={"image": ("phone.png", b"\x89PNG\r\n\x1a\nimage-data", "image/png")},
        )
        self.assertEqual(upload.status_code, 201, upload.text)
        image_url = upload.json()["image_url"]
        image = self.client.get(image_url)
        self.assertEqual(image.status_code, 200, image.text)
        self.assertEqual(image.content, b"\x89PNG\r\n\x1a\nimage-data")
        self.assertEqual(image.headers["content-type"], "image/png")
        with self.session_factory() as session:
            stored = session.get(StoredProductImage, image_url.rsplit("/", 1)[-1])
            self.assertIsNotNone(stored)
            self.assertEqual(stored.contents, image.content)

        listing = self.client.post("/api/v1/marketplace/seller/products", json={
            "name": "Samsung Galaxy A55",
            "description": "256GB smartphone",
            "price": "280.00",
            "image_url": image_url,
        })
        self.assertEqual(listing.status_code, 201, listing.text)
        self.assertEqual(listing.json()["image_url"], image_url)
        with patch("backend.app.marketplace.generate_ai_json", return_value=(None, None)):
            search = self.client.post("/api/v1/marketplace/search", json={"query": "Samsung Galaxy A55"})
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(search.json()["results"][0]["image_url"], image_url)

    def test_catalog_photo_upload_requires_seller_session_and_validates_image(self):
        registration = self.client.post("/api/v1/marketplace/seller/register", json={
            "email": "seller@example.co.zw",
            "password": "correct-horse-battery",
            "business_name": "Harare Tech",
            "phone_number": "+263771234567",
            "location": "Harare",
            "physical_address": "12 Example Road, Harare",
            "legal_status": "company",
            "terms_accepted": True,
        })
        self.assertEqual(registration.status_code, 201, registration.text)

        response = self.client.post(
            "/api/v1/marketplace/catalog/product-images",
            files={"image": ("catalog.png", b"\x89PNG\r\n\x1a\nimage-data", "image/png")},
        )
        self.assertEqual(response.status_code, 201, response.text)
        image_url = response.json()["image_url"]
        image = self.client.get(image_url)
        self.assertEqual(image.status_code, 200, image.text)
        self.assertEqual(image.content, b"\x89PNG\r\n\x1a\nimage-data")
        catalog_product = BotProduct(**BotProductCreate(
            name="Catalog phone",
            image_url=image_url,
        ).model_dump())
        with self.session_factory() as session:
            session.add(catalog_product)
            session.commit()
            session.refresh(catalog_product)
            self.assertEqual(catalog_product.image_url, image_url)


if __name__ == "__main__":
    unittest.main()
