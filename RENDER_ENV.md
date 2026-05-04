# Render environment

Render panelinde uygulama icin su environment variable degerlerini gir:

```env
ICE_TRANSPORT_POLICY=all
TURN_URLS=turn:80.225.238.243:3478?transport=udp,turn:80.225.238.243:3478?transport=tcp
TURN_USERNAME=royalstream
TURN_CREDENTIAL=Render paneline gercek TURN sifresini gir
METERED_API_KEY=
METERED_DOMAIN=
```

`ICE_TRANSPORT_POLICY=all` uretim icin dogru ayardir. Boylece baglanti mumkunse dogrudan P2P/STUN ile kurulur, TURN sadece gerekli oldugunda kullanilir.

TURN'u zorla test etmek istersen kisa sureligine `ICE_TRANSPORT_POLICY=relay` yap. Test bitince maliyet dusuk kalsin diye tekrar `all` degerine don.
