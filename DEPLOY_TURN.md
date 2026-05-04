# Kendi TURN Sunucusu Kurulumu

Kendi TURN sunucusu kaliteyi tek basina artirmaz; asil faydasi baglanti kurulamadigi aglarda WebRTC'yi calistirmak ve ticari TURN servis maliyetini kontrol etmektir. Dogrudan P2P/STUN baglantilar ucretsiz kalir. TURN sadece NAT/firewall yuzunden relay gerektiginde trafik tasir.

## Ne zaman faydali?

- Musteri kurumsal agda, CGNAT arkasinda veya kati firewall arkasindaysa.
- Ayni agda baglanamama, siyah ekran, ICE failed gibi sorunlar varsa.
- Metered/Twilio/Xirsys gibi servislerde trafik maliyeti artiyorsa.

## Sunucu gereksinimi

- 1 vCPU / 1 GB RAM baslangic icin yeterli.
- Asil maliyet bant genisligidir. 1080p ekran destegi genelde 4-12 Mbps, 2K/4K net ekran destegi 12-25 Mbps araligina cikabilir.
- UDP 3478 acik olmali. TCP 3478 ve TLS 5349 yedek olarak acilmali.
- Relay port araligi icin UDP 49152-65535 acik olmali.

## Ubuntu/Debian coturn kurulumu

```bash
sudo apt update
sudo apt install -y coturn
sudo cp deploy/coturn.conf.example /etc/turnserver.conf
sudo nano /etc/turnserver.conf
```

`/etc/default/coturn` icinde:

```bash
TURNSERVER_ENABLED=1
```

Baslat:

```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn
```

## Firewall / Oracle Cloud

Sunucu firewall:

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

Oracle Cloud Security List veya NSG tarafinda ayni inbound kurallari acilmali.

## Uygulamaya baglama

Uygulamanin `.env` dosyasina:

```env
TURN_URLS=turn:TURN_DOMAIN_OR_IP:3478?transport=udp,turn:TURN_DOMAIN_OR_IP:3478?transport=tcp
TURN_USERNAME=USERNAME
TURN_CREDENTIAL=STRONG_PASSWORD
ICE_TRANSPORT_POLICY=all
```

TLS sertifika kurulduysa ek olarak:

```env
TURN_URLS=turn:TURN_DOMAIN:3478?transport=udp,turn:TURN_DOMAIN:3478?transport=tcp,turns:TURN_DOMAIN:5349?transport=tcp
```

Test icin gecici olarak `ICE_TRANSPORT_POLICY=relay` yaparsan baglantinin mecburen TURN uzerinden gecip gecmedigini gorebilirsin. Test bitince maliyet dusuk kalsin diye `all` degerine geri al.
