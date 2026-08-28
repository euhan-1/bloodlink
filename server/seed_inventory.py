from pathlib import Path

from sqlalchemy import text

from database import engine

SEED_ROWS = [
    ("BL2025-0441", "A+", "Whole Blood", "Bay A-1", 450, "2026-06-18", "2026-07-09"),
    ("BL2025-0442", "A+", "Packed RBC", "Bay A-1", 280, "2026-06-22", "2026-08-21"),
    ("BL2025-0443", "A-", "Whole Blood", "Bay A-2", 450, "2026-06-15", "2026-07-10"),
    ("BL2025-0444", "A-", "FFP", "Freezer F-1", 200, "2026-06-01", "2026-12-01"),
    ("BL2025-0445", "B+", "Packed RBC", "Bay B-1", 280, "2026-06-20", "2026-08-19"),
    ("BL2025-0446", "B+", "Platelets", "Agitator-1", 50, "2026-07-04", "2026-07-09"),
    ("BL2025-0447", "B-", "Whole Blood", "Bay B-2", 450, "2026-06-25", "2026-08-24"),
    ("BL2025-0448", "O+", "Packed RBC", "Bay C-1", 280, "2026-06-28", "2026-08-27"),
    ("BL2025-0449", "O+", "Whole Blood", "Bay C-1", 450, "2026-06-30", "2026-07-11"),
    ("BL2025-0450", "O-", "Packed RBC", "Bay C-2", 280, "2026-07-01", "2026-08-30"),
    ("BL2025-0451", "O-", "Whole Blood", "Bay C-2", 450, "2026-06-10", "2026-07-08"),
    ("BL2025-0452", "AB+", "FFP", "Freezer F-2", 200, "2026-05-15", "2026-11-15"),
    ("BL2025-0453", "AB-", "Platelets", "Agitator-2", 50, "2026-07-03", "2026-07-08"),
]


def main():
    schema_sql = Path(__file__).parent.joinpath("schema.sql").read_text()

    with engine.begin() as conn:
        conn.execute(text(schema_sql))

        count = conn.execute(text("SELECT count(*) FROM blood_units")).scalar()
        if count > 0:
            print(f"blood_units already has {count} rows, skipping seed")
            return

        for din, blood_type, component, location, volume_ml, collected, expires in SEED_ROWS:
            conn.execute(
                text(
                    """
                    INSERT INTO blood_units
                        (din, blood_type, component, location, volume_ml, collected_date, expires_date)
                    VALUES
                        (:din, :blood_type, :component, :location, :volume_ml, :collected, :expires)
                    """
                ),
                {
                    "din": din,
                    "blood_type": blood_type,
                    "component": component,
                    "location": location,
                    "volume_ml": volume_ml,
                    "collected": collected,
                    "expires": expires,
                },
            )
        print(f"seeded {len(SEED_ROWS)} rows into blood_units")


if __name__ == "__main__":
    main()
