from pathlib import Path

from sqlalchemy import text

from database import engine

# Minimum safe-stock levels per blood type. These are a policy/config decision
# a facility would set, not something derived from inventory data — starting
# from the values used in the original design mockup as placeholder defaults.
THRESHOLDS = [
    ("A+", 80),
    ("A-", 50),
    ("B+", 60),
    ("B-", 40),
    ("O+", 100),
    ("O-", 80),
    ("AB+", 30),
    ("AB-", 25),
]


def main():
    schema_sql = Path(__file__).parent.joinpath("schema_dashboard.sql").read_text()

    with engine.begin() as conn:
        conn.execute(text(schema_sql))

        count = conn.execute(text("SELECT count(*) FROM blood_type_thresholds")).scalar()
        if count > 0:
            print(f"blood_type_thresholds already has {count} rows, skipping seed")
            return

        for blood_type, minimum_units in THRESHOLDS:
            conn.execute(
                text(
                    "INSERT INTO blood_type_thresholds (blood_type, minimum_units) "
                    "VALUES (:blood_type, :minimum_units)"
                ),
                {"blood_type": blood_type, "minimum_units": minimum_units},
            )
        print(f"seeded {len(THRESHOLDS)} thresholds")


if __name__ == "__main__":
    main()
