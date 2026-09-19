/**
 * Helpers pour la gestion des colis (Compression d'image, etc.)
 */

export async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const MAX_SIZE = 1200;

                if (width > height) {
                    if (width > MAX_SIZE) {
                        height *= MAX_SIZE / width;
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width *= MAX_SIZE / height;
                        height = MAX_SIZE;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Export en JPEG 80%
                canvas.toBlob((blob) => {
                    resolve(new File([blob], "photo.jpg", { type: 'image/jpeg' }));
                }, 'image/jpeg', 0.8);
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}
