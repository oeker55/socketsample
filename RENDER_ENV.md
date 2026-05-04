# Render environment

Render panelinde uygulama icin su environment variable degerlerini gir:

```env
ICE_TRANSPORT_POLICY=all
TURN_PROVIDER=self
TURN_URLS=turn:80.225.238.243:3478?transport=udp,turn:80.225.238.243:3478?transport=tcp
TURN_USERNAME=royalstream
TURN_CREDENTIAL=Render paneline gercek TURN sifresini gir
METERED_API_KEY=
METERED_DOMAIN=
```

`ICE_TRANSPORT_POLICY=all` uretim icin dogru ayardir. Boylece baglanti mumkunse dogrudan P2P/STUN ile kurulur, TURN sadece gerekli oldugunda kullanilir.

TURN'u zorla test etmek istersen kisa sureligine `ICE_TRANSPORT_POLICY=relay` yap. Test bitince maliyet dusuk kalsin diye tekrar `all` degerine don.

## Metered.ca performans testi

Metered.ca ile karsilastirma yapmak icin Render panelinde sadece su degerleri degistir/ekle:

```env
TURN_PROVIDER=metered
METERED_API_KEY=Metered panelindeki API key
METERED_DOMAIN=oeker55.metered.live
```

Kendi TURN sunucuna donmek icin:

```env
TURN_PROVIDER=self
```

Iki saglayiciyi ayni anda tarayiciya vermek istersen:

```env
TURN_PROVIDER=both
```

Localde Metered profiliyle calistirmak icin:

```bash
LOCAL_ENV_FILE=.env.metered npm start
```
