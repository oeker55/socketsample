const express = require('express');
const multer = require('multer');
const fs = require('fs');
const printer = require('printer');

const app = express();
const upload = multer();

app.post('/print/:printerName', upload.single('file'), async (req, res) => {
    try {
        const { printerName } = req.params;
        const file = req.file;
        
        if (!printerName || !file) {
            return res.status(400).json({ 
                error: 'Yazıcı adı ve dosya zorunludur' 
            });
        }

        // Dosya içeriğini oku
        const fileContent = fs.readFileSync(file.path, 'utf8');

        // Text dosyası olarak yazdır
        printer.printDirect({
            data: fileContent,
            printer: printerName,
            type: 'TEXT', // RAW, TEXT veya PDF
            success: function(jobID) {
                // Geçici dosyayı temizle
                fs.unlink(file.path, (err) => {
                    if (err) console.error('Geçici dosya silinemedi:', err);
                });

                res.json({ 
                    success: true, 
                    message: 'Yazdırma işlemi başlatıldı',
                    printer: printerName,
                    fileName: file.originalname,
                    jobID: jobID
                });
            },
            error: function(err) {
                // Geçici dosyayı temizle
                fs.unlink(file.path, (err) => {
                    if (err) console.error('Geçici dosya silinemedi:', err);
                });

                res.status(500).json({ 
                    error: 'Yazdırma hatası', 
                    details: err 
                });
            }
        });
    } catch (error) {
        // Hata durumunda geçici dosyayı temizle
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Geçici dosya silinemedi:', err);
            });
        }

        res.status(500).json({ 
            error: 'Yazdırma işlemi başarısız', 
            details: error.message 
        });
    }
});

app.listen(3000, () => {
    console.log('Server is running on port 3000');
}); 