require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());

// Aumentamos el límite de tamaño para aceptar imágenes y videos cortos en Base64
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ limit: '150mb', extended: true }));

app.use(express.static('public'));

// 1. Configurar Cloudinary (Tip: pasa estos valores a tu archivo .env en producción)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dxz5sofpd',
  api_key: process.env.CLOUDINARY_API_KEY || '236345187971185',
  api_secret: process.env.CLOUDINARY_API_SECRET || '5nsz7_Gs8eX3p-gDP6UdevplkFw'
});

// 2. Motor de almacenamiento Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const isVideo = file.mimetype.includes('video');
    return {
      folder: isVideo ? 'Videos' : 'Fotos',
      resource_type: isVideo ? 'video' : 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'mp4', 'mov']
    };
  },
});
const upload = multer({ storage: storage });

// 3. Configuración de la BD MySQL (Aiven)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'corretaje2-sneyeduardo4-a9be.i.aivencloud.com',
    port: process.env.DB_PORT || 16420,
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD || 'AVNS_dsgJ984KpSFsK2VpnpS',
    database: process.env.DB_NAME || 'parking',
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// ENDPOINTS MULTIMEDIA (CLOUDINARY)
// ==========================================

// NUEVO: Obtener las fotos y videos de un ticket para HistoryScreen
app.get('/api/tickets/:id/multimedia', async (req, res) => {
    try {
        const ticketId = req.params.id;
        const [rows] = await pool.execute(
            'SELECT id, id_ticket, ruta_foto FROM fotos_inspeccion WHERE id_ticket = ? ORDER BY id ASC',
            [ticketId]
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al obtener multimedia del ticket:', error);
        res.status(500).json({ error: 'Error al obtener multimedia' });
    }
});

// Endpoint: Guardar fotos y video vía Multipart
app.post('/api/tickets/:id/multimedia', (req, res) => {
    upload.fields([
        { name: 'foto', maxCount: 4 },
        { name: 'video', maxCount: 1 }
    ])(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            console.error('ERROR DE MULTER:', err);
            return res.status(500).json({ error: `Error de carga (Multer): ${err.message}` });
        } else if (err) {
            console.error('ERROR DESCONOCIDO DURANTE LA CARGA:', err);
            return res.status(500).json({ error: `Error en el servidor al subir el archivo: ${err.message}` });
        }

        try {
            const ticketId = req.params.id;
            if (!req.files || (!req.files['foto'] && !req.files['video'])) {
                return res.status(400).json({ error: 'No se enviaron archivos (foto o video).' });
            }

            if (req.files['foto']) {
                for (let foto of req.files['foto']) {
                    await pool.execute(
                        'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
                        [ticketId, foto.path]
                    );
                }
            }

            if (req.files['video']) {
                for (let video of req.files['video']) {
                    await pool.execute(
                        'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
                        [ticketId, video.path]
                    );
                }
            }

            res.status(200).json({ success: true, message: 'Evidencias guardadas en fotos_inspeccion' });
        } catch (error) {
            console.error('Error de Base de Datos al guardar ruta multimedia:', error);
            res.status(500).json({ error: 'Error interno guardando evidencias en MySQL' });
        }
    });
});

// Endpoint seguro de subida en Base64 (Soporta tanto Fotos como Videos)
// Endpoint seguro de subida en Base64 (Soporta Fotos y Videos de cualquier formato)
app.post('/api/tickets/:id/multimedia-base64', async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { fotoBase64 } = req.body;

        if (!fotoBase64) {
            return res.status(400).json({ error: 'No se recibió ningún archivo.' });
        }

        const isVideo = fotoBase64.startsWith('data:video');
        console.log(`Subiendo ${isVideo ? 'video' : 'imagen'} a Cloudinary para el ticket ${ticketId}...`);

        // resource_type: 'auto' permite que Cloudinary acepte jpg, png, mp4, mov y webm sin fallar
        const resultadoCloudinary = await cloudinary.uploader.upload(fotoBase64, {
            folder: isVideo ? 'Videos' : 'Fotos',
            resource_type: 'auto'
        });

        const urlCloudinary = resultadoCloudinary.secure_url;
        console.log(`¡Subida exitosa! URL: ${urlCloudinary}`);

        await pool.execute(
            'INSERT INTO fotos_inspeccion (id_ticket, ruta_foto) VALUES (?, ?)',
            [ticketId, urlCloudinary]
        );

        const [historialExistente] = await pool.execute(
            'SELECT id_movimiento FROM historial_movimientos WHERE id_ticket = ? AND accion = ?',
            [ticketId, 'INGRESO']
        );

        if (historialExistente.length === 0) {
            await pool.execute(
                'INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)',
                [ticketId, 'INGRESO']
            );
        }

        res.status(200).json({ success: true, message: 'Evidencia guardada correctamente', url: urlCloudinary });
    } catch (error) {
        console.error('Error detallado en Cloudinary Base64:', error);
        res.status(500).json({ error: error.message || 'Error del servidor al procesar la evidencia' });
    }
});

// Endpoint para subir QR del usuario
app.post('/api/usuarios/:id/qr', upload.single('qr'), async (req, res) => {
    try {
        const userId = req.params.id;
        if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });

        const rutaQr = req.file.path;
        await pool.execute('UPDATE usuarios SET qr_url = ? WHERE id = ?', [rutaQr, userId]);

        res.status(200).json({ success: true, message: 'QR guardado con éxito', qr_url: rutaQr });
    } catch (error) {
        console.error('Error al guardar QR:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ==========================================
// ENDPOINTS DE LÓGICA DE NEGOCIO
// ==========================================

// Checkin (Con trazabilidad del parkero)
app.post('/api/checkin', async (req, res) => {
    const {
        cedula, nombre, apellido, telefono,
        placa, marca, modelo, id_puesto, id_usuario
    } = req.body;

    if (!placa || !id_puesto) {
        return res.status(400).json({ error: 'Placa e id_puesto son obligatorios' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [ticketRes] = await connection.execute(
            `INSERT INTO tickets 
            (cedula_cliente, nombre_cliente, apellido_cliente, telefono_cliente, placa, marca, modelo, id_puesto, id_valet_ingreso, estado) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo')`,
            [
                cedula || null,
                nombre || null,
                apellido || null,
                telefono || null,
                placa,
                marca || null,
                modelo || null,
                id_puesto,
                id_usuario || null
            ]
        );
        const idTicket = ticketRes.insertId;

        await connection.execute('UPDATE puestos SET estado = ? WHERE id_puesto = ?', ['ocupado', id_puesto]);
        await connection.execute('INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)', [idTicket, 'INGRESO']);

        await connection.commit();

        // Link único que se le enviará al cliente por WhatsApp
        const linkSalida = `https://flutter-v66k.onrender.com/salida.html?ticket=${idTicket}`;

        res.status(200).json({
            success: true,
            message: 'Vehículo ingresado',
            id_ticket: idTicket,
            link_salida: linkSalida,
            datos_notificacion: {
                nombre: `${nombre || ''} ${apellido || ''}`.trim(),
                telefono: telefono || '',
                marca: marca || '',
                modelo: modelo || '',
                placa: placa,
                posicion: id_puesto,
                link_salida: linkSalida
            }
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error en checkin:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    } finally {
        connection.release();
    }
});

// Checkout
app.post('/api/checkout', async (req, res) => {
    const { id_ticket, id_puesto } = req.body;
    if (!id_ticket || !id_puesto) return res.status(400).json({ error: 'Faltan datos requeridos' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute(
            'UPDATE tickets SET estado = ?, hora_salida = CURRENT_TIMESTAMP WHERE id_ticket = ?',
            ['entregado', id_ticket]
        );
        await connection.execute('UPDATE puestos SET estado = ? WHERE id_puesto = ?', ['libre', id_puesto]);
        await connection.execute('INSERT INTO historial_movimientos (id_ticket, accion) VALUES (?, ?)', [id_ticket, 'ENTREGA']);

        await connection.commit();
        res.status(200).json({ success: true, message: 'Vehículo entregado' });
    } catch (error) {
        await connection.rollback();
        console.error('Error en checkout:', error);
        res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        connection.release();
    }
});

// Historial (Incluye el id_ticket y el nombre del operador para la galería de evidencias)
app.get('/api/historial', async (req, res) => {
    try {
        const { fecha, accion, search } = req.query;
        let sql = `
            SELECT h.id_movimiento, h.id_ticket, h.accion, h.fecha_hora, 
                   t.placa, t.marca, t.modelo, t.id_puesto,
                   u.username as operador
            FROM historial_movimientos h
            JOIN tickets t ON h.id_ticket = t.id_ticket
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            WHERE 1=1
        `;
        const params = [];

        if (search && search.trim() !== '') {
            sql += ` AND (t.placa LIKE ? OR t.marca LIKE ? OR t.modelo LIKE ? OR t.id_puesto LIKE ?)`;
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }
        if (fecha) {
            sql += ` AND DATE(h.fecha_hora) = ?`;
            params.push(fecha);
        }
        if (accion && accion !== 'TODOS') {
            sql += ` AND h.accion = ?`;
            params.push(accion);
        }
        sql += ` ORDER BY h.fecha_hora DESC LIMIT 100`;

        const [rows] = await pool.execute(sql, params);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error en historial:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// Estado Puestos
app.get('/api/puestos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT p.id_puesto, p.estado, t.id_ticket, t.placa, t.marca, t.modelo, t.hora_ingreso
            FROM puestos p
            LEFT JOIN tickets t ON p.id_puesto = t.id_puesto AND t.estado = 'activo'
        `);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Vehículos Activos
app.get('/api/tickets/activos', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT t.id_ticket, t.nombre_cliente, t.apellido_cliente, t.cedula_cliente, t.telefono_cliente,
                   t.placa, t.marca, t.modelo, t.hora_ingreso, t.estado, p.id_puesto,
                   u.username as operador
            FROM tickets t
            JOIN puestos p ON t.id_puesto = p.id_puesto
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            WHERE t.estado IN ('activo', 'solicitado')
            ORDER BY (t.estado = 'solicitado') DESC, t.hora_ingreso DESC
        `);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Stats Dashboard App
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const [ocupados] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'ocupado'");
        const [libres] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'libre'");
        const [entregados] = await pool.execute("SELECT COUNT(*) as total FROM tickets WHERE estado = 'entregado' AND DATE(hora_salida) = CURDATE()");
        res.status(200).json({ ocupados: ocupados[0].total, libres: libres[0].total, entregados: entregados[0].total });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ==========================================
// ENDPOINTS DE USUARIOS Y AUTENTICACIÓN
// ==========================================

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, rol, qr_url FROM usuarios WHERE username = ? AND password = ?',
            [username, password]
        );
        if (rows.length > 0) {
            const user = {
                id: rows[0].id,
                username: rows[0].username,
                rol: rows[0].rol,
                qr_url: rows[0].qr_url || null
            };
            // Marcamos al usuario como ACTIVO y actualizamos su último acceso para el Dashboard Web
            try {
                await pool.execute(
                    "UPDATE usuarios SET estado_conexion = 'activo', ultimo_acceso = CURRENT_TIMESTAMP WHERE id = ?",
                    [user.id]
                );
            } catch (err) {
                console.warn('Aviso: columnas estado_conexion/ultimo_acceso no encontradas:', err.message);
            }
            res.status(200).json({ success: true, user });
        } else {
            res.status(401).json({ success: false, error: 'Credenciales inválidas' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});
app.post('/api/logout/:id', async (req, res) => {
    try {
        await pool.execute("UPDATE usuarios SET estado_conexion = 'inactivo' WHERE id = ?", [req.params.id]);
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(200).json({ success: false });
    }
});
// NUEVO: Listar todos los usuarios (Para AdminPanelScreen)
app.get('/api/usuarios', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, rol, qr_url FROM usuarios ORDER BY id ASC'
        );
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al listar usuarios:', error);
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

// Crear Usuario
app.post('/api/usuarios', async (req, res) => {
    const { username, password, rol } = req.body;
    try {
        await pool.execute(
            'INSERT INTO usuarios (username, password, rol, qr_url) VALUES (?, ?, ?, NULL)',
            [username, password, rol]
        );
        res.status(201).json({ success: true, message: 'Usuario creado exitosamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// Cambiar Contraseña
app.put('/api/usuarios/:id/password', async (req, res) => {
    const userId = req.params.id;
    const { passwordActual, passwordNueva } = req.body;
    try {
        const [rows] = await pool.execute(
            'SELECT id FROM usuarios WHERE id = ? AND password = ?',
            [userId, passwordActual]
        );
        if (rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Contraseña actual incorrecta' });
        }
        await pool.execute('UPDATE usuarios SET password = ? WHERE id = ?', [passwordNueva, userId]);
        res.status(200).json({ success: true, message: 'Contraseña actualizada' });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// Eliminar Usuario (Solo Admin)
app.delete('/api/usuarios/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        if (userId === '1') {
            return res.status(403).json({ error: 'No se puede eliminar al Administrador Principal' });
        }

        const [result] = await pool.execute('DELETE FROM usuarios WHERE id = ?', [userId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.status(200).json({ success: true, message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            res.status(400).json({ error: 'No puedes borrar este valet porque tiene tickets registrados en el historial.' });
        } else {
            res.status(500).json({ error: 'Error interno del servidor al eliminar' });
        }
    }
});

// Editar Usuario (Rol o Contraseña)
app.put('/api/usuarios/:id/admin-edit', async (req, res) => {
    try {
        const userId = req.params.id;
        const { username, rol, new_password } = req.body;

        if (new_password && new_password.trim() !== '') {
            await pool.execute(
                'UPDATE usuarios SET username = ?, rol = ?, password = ? WHERE id = ?',
                [username, rol, new_password, userId]
            );
        } else {
            await pool.execute(
                'UPDATE usuarios SET username = ?, rol = ? WHERE id = ?',
                [username, rol, userId]
            );
        }

        res.status(200).json({ success: true, message: 'Usuario actualizado correctamente' });
    } catch (error) {
        console.error('Error al editar usuario:', error);
        res.status(500).json({ error: 'Error al actualizar datos del usuario' });
    }
});

// ==========================================
// ENDPOINTS PARA EL DASHBOARD ADMINISTRATIVO WEB
// ==========================================

app.get('/api/admin/stats', async (req, res) => {
    try {
        const [ocupados] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'ocupado'");
        const [libres] = await pool.execute("SELECT COUNT(*) as total FROM puestos WHERE estado = 'libre'");
        const [ingresosHoy] = await pool.execute("SELECT COUNT(*) as total FROM tickets WHERE DATE(hora_ingreso) = CURDATE()");
        const [valetsActivos] = await pool.execute("SELECT COUNT(*) as total FROM usuarios WHERE rol != 'admin'");

        res.status(200).json({
            ocupados: ocupados[0].total,
            libres: libres[0].total,
            ingresos_hoy: ingresosHoy[0].total,
            valets_activos: valetsActivos[0].total
        });
    } catch (error) {
        console.error('Error stats admin:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas admin' });
    }
});

app.get('/api/admin/valets', async (req, res) => {
    try {
        const sql = `
            SELECT u.id, u.username, u.rol, u.qr_url, u.estado_conexion, u.ultimo_acceso,
            COUNT(t.id_ticket) as autos_atendidos_hoy
            FROM usuarios u
            LEFT JOIN tickets t ON (t.id_valet_ingreso = u.id AND DATE(t.hora_ingreso) = CURDATE())
            GROUP BY u.id
            ORDER BY u.rol ASC, autos_atendidos_hoy DESC
        `;
        const [valets] = await pool.execute(sql);
        res.status(200).json(valets);
    } catch (error) {
        console.error('Error al obtener valets:', error);
        res.status(500).json({ error: 'Error al consultar valets' });
    }
});

app.get('/api/admin/vehiculos-activos', async (req, res) => {
    try {
        const sql = `
            SELECT t.id_ticket, t.placa, t.marca, t.modelo, t.hora_ingreso, t.id_puesto,
                   u.username as parkero_responsable,
                   (SELECT COUNT(*) FROM fotos_inspeccion f WHERE f.id_ticket = t.id_ticket) as total_evidencias
            FROM tickets t
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            WHERE t.estado = 'activo'
            ORDER BY t.hora_ingreso DESC
        `;
        const [rows] = await pool.execute(sql);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error en vehiculos activos admin:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/admin/evidencias-globales', async (req, res) => {
    try {
        const sql = `
            SELECT f.id, f.ruta_foto, f.creado_en, t.placa, t.marca, u.username as parkero
            FROM fotos_inspeccion f
            JOIN tickets t ON f.id_ticket = t.id_ticket
            LEFT JOIN usuarios u ON t.id_valet_ingreso = u.id
            ORDER BY f.creado_en DESC LIMIT 50
        `;
        const [rows] = await pool.execute(sql);
        res.status(200).json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar evidencias globales' });
    }
});
app.get('/api/clientes/cedula/:cedula', async (req, res) => {
    try {
        const cedula = req.params.cedula.trim();
        // Buscamos el último registro de esta cédula para traer sus datos y su último carro
        const [rows] = await pool.execute(
            `SELECT nombre_cliente, apellido_cliente, cedula_cliente, telefono_cliente, placa, marca, modelo 
             FROM tickets 
             WHERE cedula_cliente = ? 
             ORDER BY id_ticket DESC LIMIT 1`,
            [cedula]
        );

        if (rows.length > 0) {
            res.status(200).json({ found: true, cliente: rows[0] });
        } else {
            res.status(200).json({ found: false });
        }
    } catch (error) {
        console.error('Error buscando cédula:', error);
        res.status(500).json({ error: 'Error al buscar cliente' });
    }
});
app.get('/api/tickets/:id/info-publica', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id_ticket, nombre_cliente, apellido_cliente, placa, marca, modelo, id_puesto, estado FROM tickets WHERE id_ticket = ?',
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Ticket no encontrado' });
        res.status(200).json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});
app.post('/api/tickets/:id/solicitar-salida', async (req, res) => {
    try {
        const ticketId = req.params.id;
        await pool.execute(
            "UPDATE tickets SET estado = 'solicitado' WHERE id_ticket = ? AND estado = 'activo'",
            [ticketId]
        );

        res.status(200).json({
            success: true,
            message: '¡Muchas gracias por visitarnos! Nuestro personal ya fue notificado para entregarte tu vehículo.',
            instagram_url: 'https://www.instagram.com/z1gourmet/' // Pon aquí el Instagram oficial
        });
    } catch (error) {
        console.error('Error al solicitar salida:', error);
        res.status(500).json({ success: false, error: 'Error al solicitar el vehículo' });
    }
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de API corriendo en el puerto ${PORT}`);
});