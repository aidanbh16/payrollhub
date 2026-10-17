import { migrateDatabase } from "@/data/db/migrate";

migrateDatabase();
console.log("Migrations applied.");
