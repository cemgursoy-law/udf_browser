# UDF Dönüştürücü

UYAP UDF (.udf), Word (.docx) ve PDF (.pdf)  dosyalarını birbirine çeviren,
**tamamen tarayıcıda çalışan** bir araç. Kurulum yoktur — `index.html` dosyasını
açmanız yeterli.

## Gizlilik

Tüm dönüşüm kendi cihazınızda, tarayıcınızda yapılır. Hiçbir dosya internete
gönderilmez. Sayfa bir kez açıldıktan sonra internet bağlantısı olmadan da çalışır.

## Nasıl kullanılır?

1. `index.html` dosyasına çift tıklayın (varsayılan tarayıcınızda açılır).
2. Dosyaları pencereye **sürükleyip bırakın** ya da tıklayıp seçin
   (.udf, .docx veya .pdf — birden çok dosya olabilir).
3. **Hedef formatı** seçin.
4. **Dönüştür**'e basın; sonuç otomatik iner (çoklu dosyada her biri için
   indirme bağlantısı çıkar).

Sağ üstteki düğmeyle açık/koyu tema arasında geçebilirsiniz.

## Desteklenen dönüşümler

| Girdi | Çıktı          |
|-------|----------------|
| .docx | .udf · .pdf    |
| .udf  | .docx · .pdf   |
| .pdf  | .udf · .docx   |

Görseller, madde imli ve numaralı listeler, hizalama, girinti, paragraf
boşlukları ve kalın/italik biçimlendirme korunur. Türkçe karakterler (ı, İ, ş, Ş,
ğ, Ğ dahil) tüm formatlarda doğru aktarılır.

## Dosya yapısı

```
index.html    → arayüz
style.css     → tasarım (renk/ölçü değişkenleri en üstte, kolay düzenlenir)
app.js        → arayüz mantığı (sürükle-bırak, tema, dönüştürme akışı)
udf-core.js   → dosya okuma/yazma ve format dönüşümleri
libs/         → çevrimdışı çalışan kütüphaneler ve gömülü font
```

## Tasarımı düzenlemek

Renkler ve ölçüler `style.css` dosyasının en üstündeki `:root` (açık tema) ve
`[data-theme="dark"]` (koyu tema) bloklarında değişken olarak tanımlıdır. Tek bir
değeri değiştirmek tüm arayüze yansır.

## Yayınlamak (isteğe bağlı)

Sunucu tarafı kod yoktur; dosyaları olduğu gibi herhangi bir statik barındırmaya
(GitHub Pages, Netlify vb.) yükleyebilirsiniz. İşlem yine kullanıcının
tarayıcısında çalışır.

## Lisans

Bu proje MIT lisansı ile sunulur (bkz. `LICENSE`). `libs/` altındaki üçüncü taraf
kütüphaneler ve font kendi açık kaynak lisanslarıyla birlikte gelir.
