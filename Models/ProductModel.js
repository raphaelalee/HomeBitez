const db = require("../db");

module.exports = {

    getAll() {
        return db.query("SELECT id, product_name AS productName, description, price, image, category, owner_id, quantity, stock FROM product");
    },

    getById(id) {
        return db.query("SELECT id, product_name AS productName, description, price, image, category, owner_id, quantity, stock FROM product WHERE id = ?", [id]);
    },

    create(product) {
        return db.query(
            "INSERT INTO product (product_name, quantity, price, image) VALUES (?, ?, ?, ?)",
            [product.productName, product.quantity, product.price, product.image]
        );
    },

    update(id, product) {
        return db.query(
            "UPDATE product SET product_name=?, quantity=?, price=?, image=? WHERE id=?",
            [product.productName, product.quantity, product.price, product.image, id]
        );
    },

    delete(id) {
        return db.query("DELETE FROM product WHERE id = ?", [id]);
    }
};
