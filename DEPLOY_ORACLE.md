# Oracle Uzerinde Yayin Alma

Bu proje ekran paylasimi ve kamera erisimi kullandigi icin uretimde HTTPS gerektirir.

## 1. Domain'i sunucuya yonlendir

Domain A kaydini Oracle sunucunun public IP adresine bagla.

## 2. Sunucuda Docker ile uygulamayi kaldir

Proje klasorunde:

```bash
docker compose up -d --build
docker compose logs -f
```

## 3. Nginx kur

Sunucuda hangi paket yoneticisinin oldugunu kontrol et:

```bash
cat /etc/os-release
which apt
which yum
which dnf
```

Ubuntu veya Debian:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

Oracle Linux, CentOS veya RHEL uzerinde `dnf` yoksa genelde `yum` vardir:

```bash
sudo yum install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

Oracle Linux uzerinde `dnf` varsa su komutu kullan:

```bash
sudo dnf install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

## 4. Nginx ayarini kopyala

deploy/nginx.conf icindeki DOMAIN_BURAYA degerini kendi domaininle degistir.

Sonra dosyayi sunucuda su konuma koy:

```bash
sudo cp deploy/nginx.conf /etc/nginx/conf.d/canli-yayin.conf
```

Test ve reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. SSL al

```bash
sudo certbot --nginx -d senindomainin.com -d www.senindomainin.com
```

## 6. Gerekli portlari ac

Oracle security list veya NSG tarafinda 80 ve 443 inbound acik olmali.
Node uygulamasi Nginx arkasinda calisacaksa disariya 3000 acman gerekmez.

Sunucu firewall'i icin:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

## 7. TURN kullanacaksan ortam degiskenleri

docker-compose.yml ile ayni klasorde .env olustur:

```env
TURN_URLS=turn:TURN-SUNUCU-IP:3478
TURN_USERNAME=kullanici
TURN_CREDENTIAL=sifre
```

Sonra yeniden deploy et:

```bash
docker compose up -d --build
```

## 8. Son kontrol

Tarayicidan su adresle ac:

```text
https://senindomainin.com
```

IP:3000 uzerinden degil, mutlaka HTTPS domain uzerinden test et.