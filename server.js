// 1. Cargar variables de entorno (al inicio del archivo)
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer'); // 👈 AGREGA ESTA LÍNEA AQUÍ

const app = express();

// 2. Configurar PostgreSQL con process.env.DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // En producción (nube), la mayoría de BDs requieren SSL activo
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') 
    ? { rejectUnauthorized: false } 
    : false
});

// 3. Configurar el puerto con process.env.PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});

// Configuración para guardar imágenes subidas
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'public/uploads';
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// 1. Vista principal
app.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos ORDER BY id DESC');
        res.render('index', { productos: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar inventario');
    }
});

// 2. Guardar un nuevo producto con imagen
app.post('/productos', upload.single('imagen'), async (req, res) => {
    const { codigo_barras, nombre, medida, precio, stock, ubicacion } = req.body;
    const imagen = req.file ? req.file.filename : null;

    try {
        const result = await pool.query(
            `INSERT INTO productos (codigo_barras, nombre, medida, precio, stock, ubicacion, imagen)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
            [codigo_barras || null, nombre, medida, precio, stock, ubicacion, imagen]
        );
        res.render('partials/fila-producto', { producto: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al guardar producto');
    }
});

// 3. Buscar productos
app.post('/buscar', async (req, res) => {
    const { buscar } = req.body;
    try {
        const result = await pool.query(
            `SELECT * FROM productos 
       WHERE codigo_barras ILIKE $1
          OR nombre ILIKE $1 
          OR medida ILIKE $1 
          OR ubicacion ILIKE $1 
       ORDER BY id DESC`,
            [`%${buscar}%`]
        );

        let html = '';
        for (let producto of result.rows) {
            html += await new Promise((resolve, reject) => {
                app.render('partials/fila-producto', { producto }, (err, str) => {
                    if (err) reject(err);
                    else resolve(str);
                });
            });
        }

        res.send(html);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error en la búsqueda');
    }
});

// 4. Formulario de edición
app.get('/productos/:id/editar', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        res.render('partials/fila-editar-producto', { producto: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener formulario de edición');
    }
});

// 5. Obtener una sola fila (para cancelar edición)
app.get('/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        res.render('partials/fila-producto', { producto: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener producto');
    }
});

// 6. Actualizar producto (PUT) con opción a modificar la imagen
app.put('/productos/:id', upload.single('imagen'), async (req, res) => {
    const { id } = req.params;
    const { codigo_barras, nombre, medida, precio, stock, ubicacion } = req.body;

    try {
        let query = `UPDATE productos SET codigo_barras = $1, nombre = $2, medida = $3, precio = $4, stock = $5, ubicacion = $6`;
        let params = [codigo_barras || null, nombre, medida, precio, stock, ubicacion];

        if (req.file) {
            query += `, imagen = $7 WHERE id = $8 RETURNING *`;
            params.push(req.file.filename, id);
        } else {
            query += ` WHERE id = $7 RETURNING *`;
            params.push(id);
        }

        const result = await pool.query(query, params);
        res.render('partials/fila-producto', { producto: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al actualizar producto');
    }
});

// 7. Eliminar producto
app.delete('/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM productos WHERE id = $1', [id]);
        res.send('');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al eliminar producto');
    }
});
/* ==========================================
   ventas.js - Rutas y lógica para la pantalla de ventas
   ========================================== */
app.get('/ventas', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos WHERE stock > 0 ORDER BY nombre ASC');
        res.render('ventas', { productos: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar la pantalla de ventas');
    }
});

// 1. Guardar la venta y sus detalles en la base de datos
app.post('/api/ventas/procesar', async (req, res) => {
    const { carrito, metodoPago, total } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Registrar en la tabla principal de ventas
        const resVenta = await client.query(
            `INSERT INTO ventas (metodo_pago, total) VALUES ($1, $2) RETURNING id`,
            [metodoPago, total]
        );
        const ventaId = resVenta.rows[0].id;

        // Registrar cada producto en detalle_ventas y descontar stock
        for (const item of carrito) {
            const subtotal = item.precio * item.cantidad;

            await client.query(
                `INSERT INTO detalle_ventas (venta_id, producto_id, nombre_producto, precio_unitario, cantidad, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
                [ventaId, item.id, item.nombre, item.precio, item.cantidad, subtotal]
            );

            await client.query(
                `UPDATE productos SET stock = stock - $1 WHERE id = $2`,
                [item.cantidad, item.id]
            );
        }

        await client.query('COMMIT');
        res.json({ ok: true, mensaje: 'Venta registrada con éxito' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ ok: false, mensaje: 'Error al procesar la venta' });
    } finally {
        client.release();
    }
});

// 2. Ruta para ver el Historial de Ventas Realizadas
app.get('/ventas/historial', async (req, res) => {
    try {
        const consultaVentas = await pool.query(`
      SELECT 
        v.id, 
        v.fecha, 
        v.metodo_pago, 
        v.total,
        json_agg(
          json_build_object(
            'nombre', dv.nombre_producto,
            'cantidad', dv.cantidad,
            'precio_unitario', dv.precio_unitario,
            'subtotal', dv.subtotal
          )
        ) AS productos
      FROM ventas v
      JOIN detalle_ventas dv ON v.id = dv.venta_id
      GROUP BY v.id
      ORDER BY v.fecha DESC
    `);

        res.render('historial-ventas', { ventas: consultaVentas.rows });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener el historial de ventas');
    }
});

/* ==========================================
   ruta para ver proveedores
   ========================================== */
app.get('/proveedores', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM proveedores ORDER BY nombre ASC');
        res.render('proveedores', { proveedores: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar proveedores');
    }
});

// Registrar un nuevo proveedor
app.post('/proveedores', async (req, res) => {
    const { nombre, telefono, productos_vende, pais, departamento, ciudad, localidad } = req.body;
    try {
        await pool.query(
            `INSERT INTO proveedores (nombre, telefono, productos_vende, pais, departamento, ciudad, localidad)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [nombre, telefono, productos_vende, pais || 'Bolivia', departamento, ciudad, localidad]
        );
        res.redirect('/proveedores');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al guardar proveedor');
    }
});

// Eliminar un proveedor
app.delete('/proveedores/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM proveedores WHERE id = $1', [id]);
        res.send(''); // HTMX elimina la fila
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al eliminar proveedor');
    }
});

//editar proveedor

// Ruta para obtener los datos del proveedor a editar (para modal o fila)
app.get('/proveedores/editar/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM proveedores WHERE id = $1', [id]);
    res.render('partials/form-editar-proveedor', { p: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al cargar datos del proveedor');
  }
});

// Ruta para guardar la actualización del proveedor
app.put('/proveedores/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, telefono, productos_vende, pais, departamento, ciudad, localidad } = req.body;

  try {
    const result = await pool.query(
      `UPDATE proveedores 
       SET nombre = $1, telefono = $2, productos_vende = $3, pais = $4, departamento = $5, ciudad = $6, localidad = $7
       WHERE id = $8 RETURNING *`,
      [nombre, telefono, productos_vende, pais, departamento, ciudad, localidad, id]
    );

    // Retorna la fila HTML actualizada
    res.render('partials/fila-proveedor', { p: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al actualizar proveedor');
  }
});