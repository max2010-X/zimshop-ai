from sqlalchemy import Engine, inspect


def migrate_account_ownership(engine: Engine) -> None:
    statements = (
        "ALTER TABLE followups ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
        "ALTER TABLE bot_workflows ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
        "ALTER TABLE bot_contacts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
        "ALTER TABLE followups DROP CONSTRAINT IF EXISTS uq_followup_customer_message",
        "ALTER TABLE bot_contacts DROP CONSTRAINT IF EXISTS bot_contacts_whatsapp_id_key",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_followup_user_customer_message ON followups(user_id, customer, message)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_contact_user_phone_number ON bot_contacts(user_id, phone_number)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_workflow_user_id ON bot_workflows(user_id)",
    )
    with engine.begin() as connection:
        for statement in statements:
            connection.exec_driver_sql(statement)


def migrate_sms_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    with engine.begin() as connection:
        if inspector.has_table("bot_contacts"):
            columns = {column["name"] for column in inspector.get_columns("bot_contacts")}
            if "whatsapp_id" in columns and "phone_number" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts RENAME COLUMN whatsapp_id TO phone_number"
                )
            elif "phone_number" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts ADD COLUMN phone_number VARCHAR(40)"
                )
            if "sms_consent" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts ADD COLUMN sms_consent BOOLEAN NOT NULL DEFAULT FALSE"
                )
            if "marketing_consent" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts ADD COLUMN marketing_consent BOOLEAN NOT NULL DEFAULT FALSE"
                )
            if "consent_updated_at" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts ADD COLUMN consent_updated_at TIMESTAMP WITH TIME ZONE"
                )
            if "interests" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_contacts ADD COLUMN interests JSON NOT NULL DEFAULT '[]'"
                )
        if inspector.has_table("bot_workflows"):
            columns = {column["name"] for column in inspector.get_columns("bot_workflows")}
            if "phone_number" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_workflows ADD COLUMN phone_number VARCHAR(40)"
                )
            if "gateway_device_id" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_workflows ADD COLUMN gateway_device_id VARCHAR(100)"
                )
            if "gateway_last_seen" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_workflows ADD COLUMN gateway_last_seen TIMESTAMP WITH TIME ZONE"
                )
            if "sms_mode" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_workflows ADD COLUMN sms_mode VARCHAR(20) NOT NULL DEFAULT 'android'"
                )
        if inspector.has_table("bot_conversations"):
            columns = {column["name"] for column in inspector.get_columns("bot_conversations")}
            if "delivery_status" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE bot_conversations ADD COLUMN delivery_status VARCHAR(20) NOT NULL DEFAULT 'unknown'"
                )


def migrate_subscription_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    if not inspector.has_table("subscriptions"):
        return
    columns = {column["name"] for column in inspector.get_columns("subscriptions")}
    with engine.begin() as connection:
        if "trial_started_at" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE subscriptions ADD COLUMN trial_started_at TIMESTAMP WITH TIME ZONE"
            )
        if "trial_ends_at" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE subscriptions ADD COLUMN trial_ends_at TIMESTAMP WITH TIME ZONE"
            )


def migrate_marketplace_terms_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    with engine.begin() as connection:
        if inspector.has_table("users"):
            columns = {column["name"] for column in inspector.get_columns("users")}
            if "terms_accepted_at" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN terms_accepted_at TIMESTAMP WITH TIME ZONE"
                )
            if "terms_version" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE users ADD COLUMN terms_version VARCHAR(20)"
                )
        if inspector.has_table("marketplace_businesses"):
            columns = {column["name"] for column in inspector.get_columns("marketplace_businesses")}
            if "physical_address" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE marketplace_businesses ADD COLUMN physical_address TEXT NOT NULL DEFAULT ''"
                )
            if "legal_status" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE marketplace_businesses ADD COLUMN legal_status VARCHAR(30) NOT NULL DEFAULT 'individual'"
                )
            if "registration_details" not in columns:
                connection.exec_driver_sql(
                    "ALTER TABLE marketplace_businesses ADD COLUMN registration_details VARCHAR(200) NOT NULL DEFAULT ''"
                )
        if inspector.has_table("marketplace_products") and engine.dialect.name == "postgresql":
            columns = {column["name"]: column for column in inspector.get_columns("marketplace_products")}
            condition_column = columns.get("condition")
            current_length = getattr(condition_column["type"], "length", None) if condition_column else None
            if current_length is not None and current_length < 20:
                connection.exec_driver_sql(
                    "ALTER TABLE marketplace_products ALTER COLUMN condition TYPE VARCHAR(20)"
                )


def migrate_bot_product_image_schema(engine: Engine) -> None:
    if not inspect(engine).has_table("bot_products"):
        return
    columns = {column["name"] for column in inspect(engine).get_columns("bot_products")}
    if "image_url" not in columns:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE bot_products ADD COLUMN image_url VARCHAR(1000)")
