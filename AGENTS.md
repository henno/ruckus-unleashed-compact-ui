# Raadioandmete lugemine

Unleashed 200.15.6.212.27 korral kasuta raadioandmete lugemiseks olemasolevat veebiseanssi ja järgmist päringut:

- Saada POST aadressile `/admin/_cmdstat.jsp`.
- Kasuta päist `Content-Type: text/xml` ja seansi CSRF-päist `X-CSRF-Token`.
- Kasuta XML-is `action='getstat'`, `comp='stamgr'` ja elementi `<ap LEVEL='2'/>`. Ühe AP lugemiseks lisa elemendile `mac` atribuut.
- Jäta sellest päringust välja `caller='unleashed_web'`. Selle parameetriga tagastas kontrollitud püsivara raadio kanali ja sagedusala, kuid jättis RF-mõõdikud välja.
- Ära salvesta seansitunnuseid, CSRF-väärtusi ega paroole lähtekoodi või logisse.

## Arvutused ja kontroll

- Loe AP `radio` elementidest `radio-band`, `rf-samples`, `airtime-total`, `airtime-busy`, `airtime-rx`, `airtime-tx`, `noisefloor` ja `phyerr`.
- Jaga iga AirTime loendur väärtusega `rf-samples`. Tulemus on protsent; ära korruta seda uuesti sajaga.
- Jaga `phyerr` väärtusega `rf-samples`. Kuva `noisefloor` otse dBm-des.
- Kordussaatmiste ja kadude nimetaja on `radio-total-tx-mcast + radio-total-tx-fail + radio-total-tx-pkts`. Protsendi saamiseks jaga vastavalt `radio-total-retries` või `radio-total-tx-fail` nimetajaga ja korruta sajaga.
- Puuduva või vigase mõõtmise ning väljalülitatud AP korral kuva kriips. Ära asenda puuduvat näitu nulliga.
- Võrdle tulemusi algse Unleashedi AP detailvaatega. Arvesta, et eri ajal loetud väärtused võivad erineda.
- Kontrolli, et AP-de, klientide ja WLAN-ide loendid säilivad. Käivita `node --check ruckus-unleashed-compact-ui.user.js` ja `node tests/radio.test.cjs`.

Kontrollitud 29.10.2026: 23 töötava AP 46 raadio mõõdikud olid loetavad ühe üldpäringuga. Uuendus kasutab olemasolevat värskendusintervalli. Värskendusintervall ei määra kontrolleri mõõteakent. Busy üle 30% on põhjus olukorda uurida; see ei tuvasta häireallikat.

Need sammud on ainult andmete lugemiseks. Mõõdikute kuvamine ei vaja spektrianalüüsi ega uue taustaskannimise käivitamist.
