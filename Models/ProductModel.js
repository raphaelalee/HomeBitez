const db = require("../db");

let productMetaColumnsEnsured = false;

async function ensureProductMetaColumns() {
    if (productMetaColumnsEnsured) return;

    try {
        await db.query("ALTER TABLE product ADD COLUMN is_best_seller TINYINT(1) NOT NULL DEFAULT 0");
    } catch (err) {}

    try {
        await db.query("ALTER TABLE product ADD COLUMN discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0");
    } catch (err) {}

    try {
        await db.query("ALTER TABLE product ADD COLUMN dietary_tags VARCHAR(255) NULL");
    } catch (err) {}

    try {
        await db.query("ALTER TABLE product ADD COLUMN allergen_tags VARCHAR(255) NULL");
    } catch (err) {}

    productMetaColumnsEnsured = true;
}

module.exports = {

    async getAll() {
        await ensureProductMetaColumns();
        return db.query(`
            SELECT
                id,
                product_name AS productName,
                description,
                price,
                image,
                category,
                owner_id,
                quantity,
                is_best_seller AS isBestSeller,
                discount_percent AS discountPercent,
                dietary_tags AS dietaryTags,
                allergen_tags AS allergenTags
            FROM product
        `);
    },

    async getById(id) {
        await ensureProductMetaColumns();
        return db.query(`
            SELECT
                id,
                product_name AS productName,
                description,
                price,
                image,
                category,
                owner_id,
                quantity,
                is_best_seller AS isBestSeller,
                discount_percent AS discountPercent,
                dietary_tags AS dietaryTags,
                allergen_tags AS allergenTags
            FROM product
            WHERE id = ?
        `, [id]);
    },

    async create(product) {
        await ensureProductMetaColumns();
        return db.query(
            `INSERT INTO product
                (product_name, description, category, price, image, quantity, is_best_seller, discount_percent, dietary_tags, allergen_tags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                product.productName,
                product.description || "",
                product.category,
                product.price,
                product.image,
                product.quantity,
                product.isBestSeller ? 1 : 0,
                product.discountPercent || 0,
                product.dietaryTags || null,
                product.allergenTags || null
            ]
        );
    },

    async update(id, product) {
        await ensureProductMetaColumns();
        return db.query(
            `UPDATE product
             SET product_name=?, description=?, category=?, price=?, image=?, is_best_seller=?, discount_percent=?, dietary_tags=?, allergen_tags=?
             WHERE id=?`,
            [
                product.productName,
                product.description || "",
                product.category,
                product.price,
                product.image,
                product.isBestSeller ? 1 : 0,
                product.discountPercent || 0,
                product.dietaryTags || null,
                product.allergenTags || null,
                id
            ]
        );
    },

    async delete(id) {
        return db.query("DELETE FROM product WHERE id = ?", [id]);
    }
};
