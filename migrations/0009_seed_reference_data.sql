-- 0009_seed_reference_data.sql
-- Reference data only. Adding the 7th language later is exactly this INSERT and nothing else.

INSERT INTO locales (code, english_name, native_name, hreflang, url_segment, direction, sort_order, created_at) VALUES
  ('en','English',   'English',    'en', 'en', 'ltr', 10, unixepoch() * 1000),
  ('nl','Dutch',     'Nederlands', 'nl', 'nl', 'ltr', 20, unixepoch() * 1000),
  ('de','German',    'Deutsch',    'de', 'de', 'ltr', 30, unixepoch() * 1000),
  ('fr','French',    'Français',   'fr', 'fr', 'ltr', 40, unixepoch() * 1000),
  ('es','Spanish',   'Español',    'es', 'es', 'ltr', 50, unixepoch() * 1000),
  ('pt','Portuguese','Português',  'pt', 'pt', 'ltr', 60, unixepoch() * 1000);

INSERT INTO reserved_slugs (slug, reason) VALUES
  ('www','system'), ('api','system'), ('app','system'), ('admin','system'),
  ('dashboard','system'), ('cdn','system'), ('assets','system'), ('static','system'),
  ('mail','system'), ('smtp','system'), ('ftp','system'), ('blog','system'),
  ('help','system'), ('support','system'), ('status','system'), ('docs','system'),
  ('billing','system'), ('stripe','system'), ('webhook','system'), ('webhooks','system'),
  ('cname','system'), ('ns1','system'), ('ns2','system'), ('_dmarc','system'),
  ('login','system'), ('signup','system'), ('account','system'), ('preview','system');

INSERT INTO industries (key, schema_org_type, design_preset, default_page_keys, stock_query, sort_order, created_at) VALUES
  ('restaurant','Restaurant',
   '{"mood":"warm","bg":"#FFFDF7","fg":"#1A1310","accent":"#B3261E","font_display":"Playfair Display","font_body":"Inter","radius":"4px"}',
   '["home","menu","about","contact"]','restaurant interior warm',10, unixepoch() * 1000),
  ('dj','MusicGroup',
   '{"mood":"dark","bg":"#0A0A0F","fg":"#F5F5F7","accent":"#7C3AED","font_display":"Space Grotesk","font_body":"Inter","radius":"2px"}',
   '["home","about","gallery","booking","contact"]','dj nightclub lights',20, unixepoch() * 1000),
  ('hairdresser','HairSalon',
   '{"mood":"soft","bg":"#FAF7F5","fg":"#2B2320","accent":"#C99A86","font_display":"Cormorant Garamond","font_body":"Inter","radius":"12px"}',
   '["home","services","about","booking","contact"]','hair salon interior',30, unixepoch() * 1000),
  ('plumber','Plumber',
   '{"mood":"trust","bg":"#FFFFFF","fg":"#0F1B2A","accent":"#0B62D6","font_display":"Inter","font_body":"Inter","radius":"8px"}',
   '["home","services","about","contact"]','plumber at work',40, unixepoch() * 1000),
  ('physiotherapist','Physician',
   '{"mood":"calm","bg":"#F7FBFA","fg":"#12211E","accent":"#0E9384","font_display":"Inter","font_body":"Inter","radius":"10px"}',
   '["home","services","about","booking","contact"]','physiotherapy clinic',50, unixepoch() * 1000),
  ('cafe','CafeOrCoffeeShop',
   '{"mood":"cosy","bg":"#FBF6EF","fg":"#241C15","accent":"#8A5A2B","font_display":"Fraunces","font_body":"Inter","radius":"6px"}',
   '["home","menu","about","contact"]','coffee shop cosy',60, unixepoch() * 1000),
  ('photographer','ProfessionalService',
   '{"mood":"editorial","bg":"#FFFFFF","fg":"#111111","accent":"#111111","font_display":"Inter","font_body":"Inter","radius":"0px"}',
   '["home","gallery","about","contact"]','photography studio',70, unixepoch() * 1000),
  ('other','LocalBusiness',
   '{"mood":"neutral","bg":"#FFFFFF","fg":"#101828","accent":"#1570EF","font_display":"Inter","font_body":"Inter","radius":"8px"}',
   '["home","about","services","contact"]','small business storefront',999, unixepoch() * 1000);

INSERT INTO industry_translations (industry_key, locale, label) VALUES
  ('restaurant','en','Restaurant'),      ('restaurant','nl','Restaurant'),
  ('restaurant','de','Restaurant'),      ('restaurant','fr','Restaurant'),
  ('restaurant','es','Restaurante'),     ('restaurant','pt','Restaurante'),
  ('dj','en','DJ / Musician'),           ('dj','nl','DJ / Muzikant'),
  ('dj','de','DJ / Musiker'),            ('dj','fr','DJ / Musicien'),
  ('dj','es','DJ / Músico'),             ('dj','pt','DJ / Músico'),
  ('hairdresser','en','Hair Salon'),     ('hairdresser','nl','Kapsalon'),
  ('hairdresser','de','Friseursalon'),   ('hairdresser','fr','Salon de coiffure'),
  ('hairdresser','es','Peluquería'),     ('hairdresser','pt','Cabeleireiro'),
  ('plumber','en','Plumber'),            ('plumber','nl','Loodgieter'),
  ('plumber','de','Klempner'),           ('plumber','fr','Plombier'),
  ('plumber','es','Fontanero'),          ('plumber','pt','Canalizador'),
  ('physiotherapist','en','Physiotherapist'), ('physiotherapist','nl','Fysiotherapeut'),
  ('physiotherapist','de','Physiotherapeut'), ('physiotherapist','fr','Kinésithérapeute'),
  ('physiotherapist','es','Fisioterapeuta'),  ('physiotherapist','pt','Fisioterapeuta'),
  ('cafe','en','Café'),                  ('cafe','nl','Café'),
  ('cafe','de','Café'),                  ('cafe','fr','Café'),
  ('cafe','es','Cafetería'),             ('cafe','pt','Cafetaria'),
  ('photographer','en','Photographer'),  ('photographer','nl','Fotograaf'),
  ('photographer','de','Fotograf'),      ('photographer','fr','Photographe'),
  ('photographer','es','Fotógrafo'),     ('photographer','pt','Fotógrafo'),
  ('other','en','Other'),                ('other','nl','Anders'),
  ('other','de','Sonstiges'),            ('other','fr','Autre'),
  ('other','es','Otro'),                 ('other','pt','Outro');
