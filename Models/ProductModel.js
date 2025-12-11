const db = require("../db");

module.exports = {

    getAll() {
        return db.query("SELECT * FROM products");
    },

    getById(id) {
        return db.query("SELECT * FROM products WHERE id = ?", [id]);
    },

    create(product) {
        return db.query(
            "INSERT INTO products (productName, quantity, price, image) VALUES (?, ?, ?, ?)",
            [product.productName, product.quantity, product.price, product.image]
        );
    },

    update(id, product) {
        return db.query(
            "UPDATE products SET productName=?, quantity=?, price=?, image=? WHERE id=?",
            [product.productName, product.quantity, product.price, product.image, id]
        );
    },

    delete(id) {
        return db.query("DELETE FROM products WHERE id = ?", [id]);
    }
};
