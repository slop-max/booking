'use strict';
// Demo data: a few professionals in different professions and one client.
// All demo accounts use the password "demo12345". Do NOT run this in production.
const bcrypt = require('bcryptjs');
const { db, tx } = require('./db');

const hash = bcrypt.hashSync('demo12345', 10);
const prof = (name) => db.prepare('SELECT id FROM professions WHERE name_en = ?').get(name).id;

const pros = [
  ['Dr. Sara Benali', 'sara@demo.ma', 'Doctor (General Practitioner)', 'Casablanca', 'Maarif, Rue Moulay Youssef', 200, 30, 'General practice, check-ups and follow-ups.'],
  ['Dr. Ikram Elouafi', 'ikram@demo.ma', 'Dentist', 'Casablanca', 'Gauthier', 300, 45, 'Family dentistry and cosmetic care.'],
  ['Me. Youssef Alaoui', 'youssef@demo.ma', 'Lawyer', 'Rabat', 'Agdal', 500, 60, 'Business and family law.'],
  ['Salma Idrissi', 'salma@demo.ma', 'Private Tutor', 'Marrakech', 'Gueliz', 150, 60, 'Maths and physics for lycée students.'],
  ['Karim Coiffure', 'karim@demo.ma', 'Barber / Hairdresser', 'Casablanca', 'Ain Diab', 80, 30, 'Cuts, beard trims and styling.'],
];

tx(() => {
  const insU = db.prepare(`INSERT OR IGNORE INTO users (name,email,password_hash,role) VALUES (?,?,?,?)`);
  const insP = db.prepare(`INSERT OR IGNORE INTO professionals (user_id,profession_id,bio,city,address,price,duration_min) VALUES (?,?,?,?,?,?,?)`);
  const insA = db.prepare('INSERT INTO availability (pro_id,weekday,start,end) VALUES (?,?,?,?)');
  for (const [name, email, pf, city, addr, price, dur, bio] of pros) {
    insU.run(name, email, hash, 'professional');
    const id = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    if (db.prepare('SELECT 1 FROM professionals WHERE user_id = ?').get(id)) continue;
    insP.run(id, prof(pf), bio, city, addr, price, dur);
    for (let d = 1; d <= 5; d++) { insA.run(id, d, '09:00', '12:30'); insA.run(id, d, '14:00', '18:00'); }
    insA.run(id, 6, '09:00', '13:00');
  }
  insU.run('Demo Client', 'client@demo.ma', hash, 'client');
});
console.log('Demo data ready. Log in as client@demo.ma or sara@demo.ma (password: demo12345).');
