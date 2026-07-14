#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PhotonNet küresel ağ üreticisi — dünyadaki neredeyse tüm ülkelerin
başkentlerini + büyük ülkelerden ikinci bir metropolü kapsayan bir
NODES/LINKS veri seti üretir ve PhotonNet2.jsx'e yapıştırılabilir JS
literal metni olarak yazar.

Yöntem:
  - Şehir listesi: bilinen başkent/büyük şehir koordinatları (yaklaşık,
    ~0.1° hassasiyet — bu stilize bir ağ görselleştirmesi, navigasyon
    değil).
  - Projeksiyon: basit equirectangular (lat/lon -> x/y), tüm dünyayı
    kapsayan tek bir viewBox'a (W x H) oturtulur. Mevcut Türkiye
    düğümleri de AYNI projeksiyonla yeniden hesaplanır (görsel tutarlılık
    için — aksi halde iki farklı koordinat sistemi çakışır).
  - Bağlantılar: her düğüm coğrafi olarak en yakın 2 komşusuna bağlanır
    (haversine mesafesi) + kıtalar-arası "omurga" (backbone) hatları elle
    tanımlanır (denizaltı fiber kabloları mantığıyla). Sonda bağlantı
    kontrolü (union-find) yapılıp izole kalan düğümler en yakın bileşene
    bağlanır.
"""
import json
import math

# ─────────────────────────────────────────────────────────────────────────
# 1) MEVCUT (Türkiye/Ortadoğu) DÜĞÜMLER — id, label, lat, lon, type, reps, on
#    x,y BURADA VERİLMEZ — aşağıda TEK bir global projeksiyonla yeniden
#    hesaplanacak (mevcut hard-coded pixel konumları atılıyor).
# ─────────────────────────────────────────────────────────────────────────
EXISTING = [
    ("IST","İstanbul",41.0,28.9,"hub",3,True),
    ("ANK","Ankara",39.9,32.9,"hub",2,True),
    ("IZM","İzmir",38.4,27.1,"node",1,True),
    ("BUR","Bursa",40.2,29.1,"node",1,True),
    ("ADA","Adana",37.0,35.3,"node",1,True),
    ("TZN","Trabzon",41.0,39.7,"node",1,True),
    ("KON","Konya",37.9,32.5,"node",1,True),
    ("SAM","Samsun",41.3,36.3,"node",1,True),
    ("ANT","Antalya",36.9,30.7,"node",1,True),
    ("DIY","Diyarbakır",37.9,40.2,"node",1,True),
    ("EZR","Erzurum",39.9,41.3,"node",1,True),
    ("VAN","Van",38.5,43.4,"node",0,False),
    ("GAZ","Gaziantep",37.1,37.4,"node",1,True),
    ("MER","Mersin",36.8,34.6,"node",0,True),
    ("ATH","Atina",37.9,23.7,"intl",3,True),
    ("SOF","Sofya",42.7,23.3,"intl",2,True),
    ("BAG","Bağdat",33.3,44.4,"intl",2,True),
    ("CAI","Kahire",30.1,31.2,"intl",3,True),
]
EXISTING_IDS = {r[0] for r in EXISTING}

# ─────────────────────────────────────────────────────────────────────────
# 2) YENİ KÜRESEL ŞEHİRLER — (id, label, lat, lon, type, reps, on)
#    type: "hub"=büyük kıtasal omurga şehri, "intl"=ülke başkenti,
#    "node"=ikincil büyük şehir (başkent olmayan).
# ─────────────────────────────────────────────────────────────────────────
NEW = [
    # ── AVRUPA ──
    ("LON","Londra",51.5,-0.1,"hub",3,True),
    ("PAR","Paris",48.9,2.3,"hub",3,True),
    ("BER","Berlin",52.5,13.4,"hub",2,True),
    ("ROM","Roma",41.9,12.5,"intl",2,True),
    ("MAD","Madrid",40.4,-3.7,"intl",2,True),
    ("LIS","Lizbon",38.7,-9.1,"intl",2,True),
    ("AMS","Amsterdam",52.4,4.9,"hub",2,True),
    ("BRU","Brüksel",50.8,4.3,"intl",2,True),
    ("BRN","Bern",46.9,7.4,"node",1,True),
    ("ZRH","Zürih",47.4,8.5,"node",1,True),
    ("VIE","Viyana",48.2,16.4,"intl",2,True),
    ("WAW","Varşova",52.2,21.0,"intl",2,True),
    ("PRG","Prag",50.1,14.4,"intl",1,True),
    ("BTS","Bratislava",48.1,17.1,"node",1,True),
    ("BUD","Budapeşte",47.5,19.0,"intl",1,True),
    ("BUC","Bükreş",44.4,26.1,"intl",1,True),
    ("BEG","Belgrad",44.8,20.5,"intl",1,True),
    ("ZAG","Zagreb",45.8,15.9,"node",1,True),
    ("SJJ","Saraybosna",43.9,18.4,"node",1,True),
    ("LJU","Ljubljana",46.1,14.5,"node",1,True),
    ("SKP","Üsküp",42.0,21.4,"node",1,True),
    ("TIA","Tiran",41.3,19.8,"node",1,True),
    ("TGD","Podgorica",42.4,19.3,"node",0,True),
    ("PRN","Priştine",42.7,21.2,"node",0,True),
    ("KIE","Kiev",50.5,30.5,"intl",2,True),
    ("MSQ","Minsk",53.9,27.6,"node",1,True),
    ("KIS","Kişinev",47.0,28.9,"node",1,True),
    ("MOW","Moskova",55.8,37.6,"hub",3,True),
    ("LED","St. Petersburg",59.9,30.3,"node",1,True),
    ("VLN","Vilnius",54.7,25.3,"node",1,True),
    ("RIX","Riga",56.9,24.1,"node",1,True),
    ("TLL","Tallinn",59.4,24.7,"node",1,True),
    ("HEL","Helsinki",60.2,24.9,"intl",1,True),
    ("STO","Stockholm",59.3,18.1,"intl",2,True),
    ("OSL","Oslo",59.9,10.7,"intl",1,True),
    ("CPH","Kopenhag",55.7,12.6,"intl",1,True),
    ("REY","Reykjavik",64.1,-21.9,"node",0,True),
    ("DUB","Dublin",53.3,-6.3,"intl",1,True),
    ("LUX","Lüksemburg",49.6,6.1,"node",0,True),
    ("VLT","Valletta",35.9,14.5,"node",0,True),
    ("NIC","Lefkoşa",35.2,33.4,"node",0,True),
    ("FRA","Frankfurt",50.1,8.7,"node",1,True),
    ("MUC","Münih",48.1,11.6,"node",1,True),
    ("MIL","Milano",45.5,9.2,"node",1,True),
    ("BCN","Barselona",41.4,2.2,"node",1,True),

    # ── ASYA ──
    ("TBS","Tiflis",41.7,44.8,"node",1,True),
    ("EVN","Erivan",40.2,44.5,"node",1,True),
    ("GYD","Bakü",40.4,49.9,"node",1,True),
    ("THR","Tahran",35.7,51.4,"intl",2,True),
    ("DAM","Şam",33.5,36.3,"node",0,True),
    ("BEY","Beyrut",33.9,35.5,"node",0,True),
    ("JRS","Kudüs",31.8,35.2,"node",1,True),
    ("TLV","Tel Aviv",32.1,34.8,"node",1,True),
    ("AMM","Amman",31.9,35.9,"node",1,True),
    ("RUH","Riyad",24.7,46.7,"intl",2,True),
    ("SAA","Sana",15.4,44.2,"node",0,True),
    ("MCT","Maskat",23.6,58.5,"node",1,True),
    ("AUH","Abu Dabi",24.5,54.4,"intl",2,True),
    ("DXB","Dubai",25.2,55.3,"hub",3,True),
    ("DOH","Doha",25.3,51.5,"intl",2,True),
    ("BAH","Manama",26.2,50.6,"node",1,True),
    ("KWI","Kuveyt",29.4,48.0,"node",1,True),
    ("NUR","Astana",51.2,71.4,"intl",1,True),
    ("ALA","Almatı",43.2,76.9,"node",1,True),
    ("TAS","Taşkent",41.3,69.2,"intl",1,True),
    ("ASB","Aşkabat",37.9,58.4,"node",0,True),
    ("DYU","Duşanbe",38.6,68.8,"node",0,True),
    ("FRU","Bişkek",42.9,74.6,"node",0,True),
    ("KBL","Kabil",34.6,69.2,"node",0,True),
    ("ISB","İslamabad",33.7,73.0,"intl",1,True),
    ("KHI","Karaçi",24.9,67.0,"node",1,True),
    ("DEL","Yeni Delhi",28.6,77.2,"hub",3,True),
    ("BOM","Mumbai",19.1,72.9,"hub",2,True),
    ("KTM","Katmandu",27.7,85.3,"node",0,True),
    ("THI","Thimphu",27.5,89.6,"node",0,True),
    ("DAC","Dakka",23.8,90.4,"intl",1,True),
    ("CMB","Kolombo",6.9,79.9,"intl",1,True),
    ("MLE","Male",4.2,73.5,"node",0,True),
    ("NPT","Naypyidaw",19.7,96.1,"node",0,True),
    ("RGN","Yangon",16.8,96.2,"node",1,True),
    ("BKK","Bangkok",13.8,100.5,"intl",2,True),
    ("VTE","Vientiane",18.0,102.6,"node",0,True),
    ("PNH","Phnom Penh",11.6,104.9,"node",0,True),
    ("HAN","Hanoi",21.0,105.8,"intl",1,True),
    ("SGN","Ho Chi Minh",10.8,106.6,"node",1,True),
    ("KUL","Kuala Lumpur",3.1,101.7,"intl",2,True),
    ("SIN","Singapur",1.35,103.8,"hub",3,True),
    ("JKT","Cakarta",-6.2,106.8,"hub",2,True),
    ("MNL","Manila",14.6,121.0,"intl",2,True),
    ("BWN","Bandar Seri Begawan",4.9,114.9,"node",0,True),
    ("DIL","Dili",-8.6,125.6,"node",0,True),
    ("BJS","Pekin",39.9,116.4,"hub",3,True),
    ("SHA","Şanghay",31.2,121.5,"hub",3,True),
    ("HKG","Hong Kong",22.3,114.2,"node",2,True),
    ("ULN","Ulan Batur",47.9,106.9,"node",0,True),
    ("FNJ","Pyongyang",39.0,125.8,"node",0,False),
    ("SEL","Seul",37.6,127.0,"hub",2,True),
    ("TYO","Tokyo",35.7,139.7,"hub",3,True),
    ("OSA","Osaka",34.7,135.5,"node",1,True),
    ("TPE","Taipei",25.0,121.6,"node",2,True),

    # ── AFRİKA ──
    ("TIP","Trablus",32.9,13.2,"node",0,True),
    ("TUN","Tunus",36.8,10.2,"node",1,True),
    ("ALG","Cezayir",36.8,3.1,"intl",1,True),
    ("RBA","Rabat",34.0,-6.8,"node",1,True),
    ("CAS","Kazablanka",33.6,-7.6,"node",1,True),
    ("NKC","Nuakşot",18.1,-15.9,"node",0,True),
    ("BKO","Bamako",12.6,-8.0,"node",0,True),
    ("NIM","Niamey",13.5,2.1,"node",0,True),
    ("NDJ","N'Djamena",12.1,15.0,"node",0,True),
    ("KRT","Hartum",15.6,32.5,"node",1,True),
    ("JUB","Cuba",4.9,31.6,"node",0,False),
    ("ASM","Asmara",15.3,38.9,"node",0,True),
    ("JIB","Cibuti",11.6,43.1,"node",0,True),
    ("ADD","Addis Ababa",9.0,38.7,"intl",2,True),
    ("MGQ","Mogadişu",2.0,45.3,"node",0,False),
    ("NBO","Nairobi",-1.3,36.8,"hub",2,True),
    ("KLA","Kampala",0.3,32.6,"node",1,True),
    ("KGL","Kigali",-1.9,30.1,"node",1,True),
    ("GIT","Gitega",-3.4,29.9,"node",0,True),
    ("DOD","Dodoma",-6.2,35.7,"node",0,True),
    ("DAR","Dar es Selam",-6.8,39.3,"node",1,True),
    ("DKR","Dakar",14.7,-17.4,"intl",2,True),
    ("BJL","Banjul",13.5,-16.6,"node",0,True),
    ("OXB","Bissau",11.9,-15.6,"node",0,True),
    ("CKY","Conakry",9.5,-13.7,"node",0,True),
    ("FNA","Freetown",8.5,-13.2,"node",0,True),
    ("MLW","Monrovia",6.3,-10.8,"node",0,True),
    ("ABJ","Abidjan",5.3,-4.0,"node",1,True),
    ("YAM","Yamoussoukro",6.8,-5.3,"node",0,True),
    ("ACC","Akra",5.6,-0.2,"intl",1,True),
    ("LFW","Lome",6.1,1.2,"node",0,True),
    ("PNV","Porto-Novo",6.5,2.6,"node",0,True),
    ("OUA","Ouagadougou",12.4,-1.5,"node",0,True),
    ("ABV","Abuja",9.1,7.5,"intl",1,True),
    ("LOS","Lagos",6.5,3.4,"hub",3,True),
    ("YAO","Yaunde",3.9,11.5,"node",0,True),
    ("BGF","Bangui",4.4,18.6,"node",0,False),
    ("SSG","Malabo",3.75,8.78,"node",0,True),
    ("LBV","Librevil",0.4,9.5,"node",0,True),
    ("BZV","Brazavil",-4.3,15.3,"node",0,True),
    ("FIH","Kinşasa",-4.4,15.3,"node",1,True),
    ("LAD","Luanda",-8.8,13.2,"intl",1,True),
    ("LUN","Lusaka",-15.4,28.3,"node",1,True),
    ("LLW","Lilongwe",-14.0,33.8,"node",0,True),
    ("MPM","Maputo",-26.0,32.6,"node",1,True),
    ("HRE","Harare",-17.8,31.1,"node",1,True),
    ("GBE","Gaborone",-24.7,25.9,"node",0,True),
    ("WDH","Windhoek",-22.6,17.1,"node",0,True),
    ("JNB","Johannesburg",-26.2,28.0,"hub",3,True),
    ("PRY","Pretoria",-25.8,28.2,"node",1,True),
    ("CPT","Cape Town",-33.9,18.4,"node",2,True),
    ("MBB","Mbabane",-26.3,31.1,"node",0,True),
    ("MSU","Maseru",-29.3,27.5,"node",0,True),
    ("TNR","Antananarivo",-18.9,47.5,"node",1,True),
    ("MRU","Port Louis",-20.2,57.5,"node",0,True),
    ("YVA","Moroni",-11.7,43.3,"node",0,True),
    ("SEZ","Victoria",-4.6,55.5,"node",0,True),
    ("RAI","Praia",14.9,-23.5,"node",0,True),

    # ── KUZEY AMERİKA ──
    ("WAS","Washington",38.9,-77.0,"hub",3,True),
    ("NYC","New York",40.7,-74.0,"hub",3,True),
    ("LAX","Los Angeles",34.1,-118.2,"hub",3,True),
    ("CHI","Chicago",41.9,-87.6,"node",2,True),
    ("MIA","Miami",25.8,-80.2,"node",2,True),
    ("OTT","Ottawa",45.4,-75.7,"intl",1,True),
    ("YTO","Toronto",43.7,-79.4,"hub",2,True),
    ("YVR","Vancouver",49.3,-123.1,"node",1,True),
    ("MEX","Meksika",19.4,-99.1,"hub",3,True),
    ("GDL","Guadalajara",20.7,-103.3,"node",1,True),
    ("GUA","Guatemala",14.6,-90.5,"node",0,True),
    ("BZE","Belmopan",17.25,-88.77,"node",0,True),
    ("TGU","Tegucigalpa",14.1,-87.2,"node",0,True),
    ("SAL","San Salvador",13.7,-89.2,"node",0,True),
    ("MGA","Managua",12.1,-86.2,"node",0,True),
    ("SJO","San Jose",9.9,-84.1,"node",1,True),
    ("PTY","Panama",9.0,-79.5,"intl",1,True),
    ("HAV","Havana",23.1,-82.4,"node",1,True),
    ("KIN","Kingston",18.0,-76.8,"node",0,True),
    ("PAP","Port-au-Prince",18.5,-72.3,"node",0,False),
    ("SDQ","Santo Domingo",18.5,-69.9,"node",1,True),
    ("NAS","Nassau",25.0,-77.4,"node",0,True),
    ("POS","Port of Spain",10.7,-61.5,"node",0,True),
    ("BGI","Bridgetown",13.1,-59.6,"node",0,True),

    # ── GÜNEY AMERİKA ──
    ("BOG","Bogota",4.7,-74.1,"intl",2,True),
    ("CCS","Karakas",10.5,-66.9,"node",1,True),
    ("GEO","Georgetown",6.8,-58.2,"node",0,True),
    ("PBM","Paramaribo",5.9,-55.2,"node",0,True),
    ("UIO","Quito",-0.2,-78.5,"node",1,True),
    ("LIM","Lima",-12.0,-77.0,"intl",2,True),
    ("BSB","Brasilia",-15.8,-47.9,"hub",2,True),
    ("SAO","Sao Paulo",-23.5,-46.6,"hub",3,True),
    ("RIO","Rio de Janeiro",-22.9,-43.2,"node",2,True),
    ("LPB","La Paz",-16.5,-68.2,"node",1,True),
    ("ASU","Asuncion",-25.3,-57.6,"node",1,True),
    ("SCL","Santiago",-33.4,-70.7,"intl",2,True),
    ("BUE","Buenos Aires",-34.6,-58.4,"hub",3,True),
    ("MVD","Montevideo",-34.9,-56.2,"node",1,True),

    # ── OKYANUSYA ──
    ("CBR","Canberra",-35.3,149.1,"node",1,True),
    ("SYD","Sidney",-33.9,151.2,"hub",3,True),
    ("MEL","Melbourne",-37.8,145.0,"node",2,True),
    ("WLG","Wellington",-41.3,174.8,"node",1,True),
    ("AKL","Auckland",-36.8,174.8,"node",1,True),
    ("POM","Port Moresby",-9.5,147.2,"node",0,True),
    ("SUV","Suva",-18.1,178.4,"node",0,True),
    ("HIR","Honiara",-9.4,159.9,"node",0,True),
    ("VLI","Port Vila",-17.7,168.3,"node",0,True),
    ("APW","Apia",-13.8,-171.8,"node",0,True),
    ("TBU","Nukualofa",-21.1,-175.2,"node",0,True),
    ("TRW","Tarawa",1.3,173.0,"node",0,False),
    ("PNI","Palikir",6.9,158.2,"node",0,False),
    ("ROR","Ngerulmud",7.5,134.6,"node",0,False),
    ("MAJ","Majuro",7.1,171.4,"node",0,False),

    # ── EK BÜYÜK METROPOLLER (başkent olmayan, ~250-300 hedefine tamamlama) ──
    ("HAM","Hamburg",53.6,10.0,"node",1,True),
    ("RTM","Rotterdam",51.9,4.5,"node",1,True),
    ("NAP","Napoli",40.9,14.3,"node",0,True),
    ("VLC","Valencia",39.5,-0.4,"node",0,True),
    ("LYS","Lyon",45.8,4.8,"node",1,True),
    ("MAN","Manchester",53.5,-2.2,"node",1,True),
    ("EDI","Edinburgh",55.95,-3.2,"node",0,True),
    ("CTU","Chengdu",30.7,104.1,"node",1,True),
    ("CAN","Guangzhou",23.1,113.3,"node",2,True),
    ("SZX","Shenzhen",22.5,114.1,"node",2,True),
    ("BLR","Bangalore",13.0,77.6,"node",1,True),
    ("MAA","Chennai",13.1,80.3,"node",1,True),
    ("CCU","Kolkata",22.6,88.4,"node",1,True),
    ("AMD","Ahmedabad",23.0,72.6,"node",0,True),
    ("NGO","Nagoya",35.2,136.9,"node",1,True),
    ("YOK","Yokohama",35.4,139.6,"node",1,True),
    ("ALY","İskenderiye",31.2,29.9,"node",0,True),
    ("KAN","Kano",12.0,8.5,"node",0,True),
    ("IBA","Ibadan",7.4,3.9,"node",0,True),
    ("DUR","Durban",-29.9,31.0,"node",1,True),
    ("HOU","Houston",29.8,-95.4,"node",1,True),
    ("DAL","Dallas",32.8,-96.8,"node",1,True),
    ("PHL","Philadelphia",40.0,-75.2,"node",1,True),
    ("SFO","San Francisco",37.8,-122.4,"node",2,True),
    ("SEA","Seattle",47.6,-122.3,"node",1,True),
    ("BOS","Boston",42.4,-71.1,"node",1,True),
    ("ATL","Atlanta",33.7,-84.4,"node",1,True),
    ("YMQ","Montreal",45.5,-73.6,"node",1,True),
    ("YYC","Calgary",51.0,-114.1,"node",0,True),
    ("MTY","Monterrey",25.7,-100.3,"node",0,True),
    ("CWB","Curitiba",-25.4,-49.3,"node",0,True),
    ("POA","Porto Alegre",-30.0,-51.2,"node",0,True),
    ("MDE","Medellin",6.3,-75.6,"node",0,True),
    ("SSA","Salvador",-12.97,-38.5,"node",0,True),
    ("BNE","Brisbane",-27.5,153.0,"node",1,True),
    ("PER","Perth",-31.95,115.9,"node",1,True),
    ("CHC","Christchurch",-43.5,172.6,"node",0,True),
]

NEW_IDS = [r[0] for r in NEW]
assert len(NEW_IDS) == len(set(NEW_IDS)), "YENİ listede tekrar eden id var!"
collisions = set(NEW_IDS) & EXISTING_IDS
assert not collisions, f"Mevcut id'lerle çakışma: {collisions}"

ALL = EXISTING + NEW
print(f"Toplam düğüm sayısı: {len(ALL)}")

# ─────────────────────────────────────────────────────────────────────────
# 3) PROJEKSİYON — tüm dünyayı kapsayan tek bir equirectangular harita.
# ─────────────────────────────────────────────────────────────────────────
W, H = 1000, 520
LAT_MAX, LAT_MIN = 75.0, -48.0
LON_MIN, LON_MAX = -180.0, 185.0

def project(lat, lon):
    x = (lon - LON_MIN) / (LON_MAX - LON_MIN) * W
    y = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * H
    return round(x, 1), round(y, 1)

NODE_XY = {}
for (nid, label, lat, lon, typ, reps, on) in ALL:
    NODE_XY[nid] = project(lat, lon)

# ─────────────────────────────────────────────────────────────────────────
# 4) HAVERSINE MESAFESİ (km) + kablo-yönlendirme gerçekçiliği için ×1.3 çarpanı
#    (mevcut IST-ANK verisi de kuş-uçuşu ~360km yerine 452km kullanıyor,
#    yani zaten ~1.25-1.3x — tutarlı kalmak için aynı çarpanı uyguluyoruz).
# ─────────────────────────────────────────────────────────────────────────
def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(a))

ROUTING_FACTOR = 1.3
LATLON = {r[0]: (r[2], r[3]) for r in ALL}

def route_km(a, b):
    lat1, lon1 = LATLON[a]
    lat2, lon2 = LATLON[b]
    return round(haversine_km(lat1, lon1, lat2, lon2) * ROUTING_FACTOR)

# ─────────────────────────────────────────────────────────────────────────
# 5) BAĞLANTILAR (LINKS)
#    a) Mevcut 27 Türkiye/Ortadoğu bağlantısı AYNEN korunur (km/nm değerleri
#       zaten elle ayarlanmış gerçekçi değerler, projeksiyon değişse bile
#       geçerliliğini korur).
#    b) Her yeni düğüm coğrafi en-yakın 2 komşusuna bağlanır.
#    c) Kıtalar-arası omurga (backbone) hatları elle eklenir.
#    d) Bağlı-bileşen kontrolü (union-find) — izole kalan düğüm en yakın
#       bileşene bağlanır.
# ─────────────────────────────────────────────────────────────────────────
EXISTING_LINKS = [
    ("IST","BUR",85,1550),("IST","ANK",452,1550),("IST","SAM",750,1310),
    ("IST","SOF",560,1310),("BUR","IZM",250,1550),("BUR","ANK",380,1550),
    ("IZM","ANT",480,1310),("IZM","ATH",650,1310),("ANK","KON",260,1550),
    ("ANK","SAM",420,1550),("ANK","ADA",490,1310),("ANK","TZN",620,1310),
    ("ANK","EZR",870,1310),("KON","ANT",310,1550),("KON","ADA",350,1550),
    ("ADA","DIY",360,850), ("ADA","MER",75, 1550),("ADA","GAZ",220,1550),
    ("TZN","EZR",325,1550),("SAM","TZN",360,1550),("DIY","EZR",300,850),
    ("DIY","GAZ",185,1550),("EZR","VAN",215,850), ("VAN","BAG",640,850),
    ("GAZ","BAG",560,1310),("MER","CAI",1100,1310),("ATH","CAI",1750,1310),
    ("ANT","CAI",1400,1310),
]

all_ids = [r[0] for r in ALL]
edges = set()
for a, b, km, nm in EXISTING_LINKS:
    edges.add(tuple(sorted((a, b))))

link_list = list(EXISTING_LINKS)

# -- en-yakın-2-komşu --
new_ids = [r[0] for r in NEW]
for nid in new_ids:
    lat1, lon1 = LATLON[nid]
    dists = []
    for other in all_ids:
        if other == nid:
            continue
        lat2, lon2 = LATLON[other]
        d = haversine_km(lat1, lon1, lat2, lon2)
        dists.append((d, other))
    dists.sort()
    added = 0
    for d, other in dists:
        key = tuple(sorted((nid, other)))
        if key in edges:
            added += 1
            if added >= 2:
                break
            continue
        edges.add(key)
        km = route_km(nid, other)
        nm = 1550 if km > 300 else (1310 if km > 120 else 850)
        link_list.append((nid, other, km, nm))
        added += 1
        if added >= 2:
            break

# -- kıtalar-arası omurga hatları (denizaltı fiber mantığı) --
BACKBONE = [
    ("LON","NYC"), ("NYC","LAX"), ("LAX","TYO"), ("TYO","SIN"),
    ("SIN","BOM"), ("BOM","DXB"), ("DXB","CAI"), ("LON","LOS"),
    ("LOS","JNB"), ("JNB","BOM"), ("SAO","LIS"), ("SAO","NYC"),
    ("SYD","SIN"), ("SYD","LAX"), ("MOW","BJS"), ("BJS","DEL"),
    ("IST","DXB"), ("IST","MOW"), ("IST","LON"), ("PAR","LON"),
    ("PAR","BER"), ("BER","MOW"), ("DEL","SIN"), ("SHA","SIN"),
    ("SEL","TYO"), ("MEX","LAX"), ("MEX","BOG"), ("BOG","LIM"),
    ("LIM","SCL"), ("SCL","BUE"), ("BUE","SAO"), ("NBO","DXB"),
    ("NBO","JNB"), ("CAI","IST"), ("AUH","BOM"), ("WLG","SYD"),
    ("AKL","SYD"), ("HKG","SHA"), ("HKG","SIN"), ("YTO","NYC"),
    ("YVR","LAX"), ("YVR","TYO"),
]
for a, b in BACKBONE:
    key = tuple(sorted((a, b)))
    if key in edges:
        continue
    edges.add(key)
    km = route_km(a, b)
    nm = 1550
    link_list.append((a, b, km, nm))

# -- bağlı-bileşen kontrolü (union-find) --
parent = {nid: nid for nid in all_ids}
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x
def union(x, y):
    rx, ry = find(x), find(y)
    if rx != ry:
        parent[rx] = ry

for a, b, km, nm in link_list:
    union(a, b)

components = {}
for nid in all_ids:
    components.setdefault(find(nid), []).append(nid)

if len(components) > 1:
    comp_list = list(components.values())
    main = max(comp_list, key=len)
    for comp in comp_list:
        if comp is main:
            continue
        # bu izole bileşenin en "merkezi" düğümünü ana bileşendeki en yakın
        # düğüme bağla (izole ada ülkeleri için gerçekçi: tek bir uzun
        # denizaltı kablosu ile ana omurgaya bağlanırlar).
        rep = comp[0]
        lat1, lon1 = LATLON[rep]
        best = None
        best_d = None
        for other in main:
            lat2, lon2 = LATLON[other]
            d = haversine_km(lat1, lon1, lat2, lon2)
            if best_d is None or d < best_d:
                best_d, best = d, other
        km = route_km(rep, best)
        link_list.append((rep, best, km, 1550))
        union(rep, best)
        main = main + comp

# son kontrol
parent2 = {nid: nid for nid in all_ids}
def find2(x):
    while parent2[x] != x:
        parent2[x] = parent2[parent2[x]]
        x = parent2[x]
    return x
def union2(x, y):
    rx, ry = find2(x), find2(y)
    if rx != ry:
        parent2[rx] = ry
for a, b, km, nm in link_list:
    union2(a, b)
final_components = len({find2(nid) for nid in all_ids})
print(f"Toplam bağlantı sayısı: {len(link_list)} | bağlı bileşen sayısı (1 olmalı): {final_components}")

# ─────────────────────────────────────────────────────────────────────────
# 6) JS ÇIKTI ÜRETİMİ
# ─────────────────────────────────────────────────────────────────────────
def js_str(s):
    return json.dumps(s, ensure_ascii=False)

lines = []
lines.append("const NODES=[")
for (nid, label, lat, lon, typ, reps, on) in ALL:
    x, y = NODE_XY[nid]
    lines.append(
        f'  {{id:"{nid}",label:{js_str(label)},x:{x},y:{y},type:"{typ}",'
        f'on:{"true" if on else "false"},reps:{reps},lat:{lat},lon:{lon}}},'
    )
lines.append("];")
lines.append("const LINKS=[")
for (a, b, km, nm) in link_list:
    lines.append(f'  {{a:"{a}",b:"{b}",km:{km},nm:{nm}}},')
lines.append("];")

out = "\n".join(lines)
with open("world_network.js", "w", encoding="utf-8") as f:
    f.write(out)

print("world_network.js yazıldı.")
print(f"NODES satır sayısı: {len(ALL)}  LINKS satır sayısı: {len(link_list)}")
