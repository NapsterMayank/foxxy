import type { GoldenQuestion } from './types';

/**
 * FIFTY QUESTIONS THE CORPUS IS KNOWN TO ANSWER — §8.4's calibration set.
 *
 * =============================================================================
 * HOW THESE WERE CHOSEN, because a badly-chosen set produces a number that
 * looks measured and is not.
 *
 * Every one is anchored to a REAL CHAPTER in the imported corpus, read out of
 * `chapters` on 10 August 2026 — not invented from a syllabus document. The
 * corpus has 137 chapters across grades 6-10, mathematics and science; the
 * spread below covers all five grades and both subjects roughly in proportion
 * to their chunk counts (grade 9 science is the largest at 718 chunks, grade 6
 * mathematics the smallest at 346).
 *
 * They are written the way a STUDENT types, not the way a syllabus is titled.
 * "what is the least distance of distinct vision" is a question; "Light —
 * Reflection and Refraction" is a heading, and calibrating on headings measures
 * how well the retriever matches titles, which is not the thing being shipped.
 *
 * NINE of the 137 chapters carry placeholder titles ('Science - Chapter 10',
 * 'Chapter 15') because the source had none. Questions are still drawn from
 * some of them — the CHUNKS are real even where the title is not, and skipping
 * them would bias the set toward the chapters somebody happened to name.
 *
 * =============================================================================
 * THIS SET IS NOT A TEST FIXTURE AND MUST NOT BECOME ONE.
 *
 * Nothing in `src/` imports it. It exists to be scored by the harness once a
 * `VOYAGE_API_KEY` exists. If a unit test ever starts asserting against these
 * strings they stop being an independent measurement and become part of the
 * thing being measured.
 */
export const IN_CORPUS_QUESTIONS: readonly GoldenQuestion[] = [
  // --- Grade 10 science ----------------------------------------------------
  {
    query: 'why does a pencil look bent when it is put in a glass of water',
    grade: '10',
    subject: 'science',
    note: 'Light - Reflection and Refraction (ch 9)',
  },
  {
    query: 'what is the least distance of distinct vision for a normal eye',
    grade: '10',
    subject: 'science',
    note: 'The Human Eye and the Colourful World (ch 10, placeholder title)',
  },
  {
    query: 'how is nutrition different in amoeba and in human beings',
    grade: '10',
    subject: 'science',
    note: 'Life Processes (ch 5)',
  },
  {
    query: 'what happens when an acid reacts with a metal carbonate',
    grade: '10',
    subject: 'science',
    note: 'Acids, Bases and Salts (ch 2)',
  },
  {
    query: 'why is sodium kept immersed in kerosene oil',
    grade: '10',
    subject: 'science',
    note: 'Metals and Non-metals (ch 3)',
  },
  {
    query: 'what are isomers and why does carbon form so many compounds',
    grade: '10',
    subject: 'science',
    note: 'Carbon and its Compounds (ch 4)',
  },
  {
    query: 'explain the difference between sexual and asexual reproduction',
    grade: '10',
    subject: 'science',
    note: 'How do Organisms Reproduce (ch 7)',
  },
  {
    query: 'what did mendel find out from his experiments on pea plants',
    grade: '10',
    subject: 'science',
    note: 'Heredity and Evolution (ch 8)',
  },
  {
    query: 'what is a food chain and what are the trophic levels in it',
    grade: '10',
    subject: 'science',
    note: 'Our Environment (ch 13)',
  },
  {
    query: 'why is the sky blue and why does the sun look red at sunset',
    grade: '10',
    subject: 'science',
    note: 'The Human Eye and the Colourful World (ch 10)',
  },
  // --- Grade 10 mathematics -------------------------------------------------
  {
    query: 'prove that root 2 is an irrational number',
    grade: '10',
    subject: 'mathematics',
    note: 'Real Numbers (ch 1)',
  },
  {
    query: 'how do i solve two linear equations by the substitution method',
    grade: '10',
    subject: 'mathematics',
    note: 'Pair of Linear Equations in Two Variables (ch 3)',
  },
  {
    query: 'state and explain the basic proportionality theorem',
    grade: '10',
    subject: 'mathematics',
    note: 'Triangles (ch 6)',
  },
  {
    query: 'what is the curved surface area of a cone',
    grade: '10',
    subject: 'mathematics',
    note: 'Surface Areas and Volumes (ch 12)',
  },
  {
    query: 'how do i find the hcf and lcm using prime factorisation',
    grade: '10',
    subject: 'mathematics',
    note: 'Real Numbers (ch 1)',
  },
  {
    query: 'when are two triangles said to be similar',
    grade: '10',
    subject: 'mathematics',
    note: 'Triangles (ch 6)',
  },
  // --- Grade 9 science ------------------------------------------------------
  {
    query: 'why does evaporation cause cooling',
    grade: '9',
    subject: 'science',
    note: 'Matter in Our Surroundings (ch 1)',
  },
  {
    query: 'what is the difference between a mixture and a compound',
    grade: '9',
    subject: 'science',
    note: 'Is Matter Around Us Pure (ch 2)',
  },
  {
    query: 'explain rutherford alpha particle scattering experiment',
    grade: '9',
    subject: 'science',
    note: 'Structure of the Atom (ch 4)',
  },
  {
    query: 'state newtons second law of motion with an example',
    grade: '9',
    subject: 'science',
    note: 'Force and Laws of Motion (ch 8)',
  },
  {
    query: 'what is inertia and how is it related to mass',
    grade: '9',
    subject: 'science',
    note: 'Force and Laws of Motion (ch 8)',
  },
  {
    query: 'what is mixed cropping and how is it different from intercropping',
    grade: '9',
    subject: 'science',
    note: 'Improvement in Food Resources (ch 12)',
  },
  {
    query: 'what are valence electrons and how do i find the valency of an element',
    grade: '9',
    subject: 'science',
    note: 'Structure of the Atom (ch 4)',
  },
  {
    query: 'how do i separate a mixture of common salt and ammonium chloride',
    grade: '9',
    subject: 'science',
    note: 'Is Matter Around Us Pure (ch 2)',
  },
  {
    query: 'what is the difference between speed and velocity',
    grade: '9',
    subject: 'science',
    note: 'Motion (ch 7, placeholder title)',
  },
  {
    query: 'why do we feel a backward push when a gun is fired',
    grade: '9',
    subject: 'science',
    note: 'Force and Laws of Motion (ch 8) — conservation of momentum',
  },
  // --- Grade 9 mathematics --------------------------------------------------
  {
    query: 'what are the coordinates of a point in the third quadrant',
    grade: '9',
    subject: 'mathematics',
    note: 'Coordinate Geometry (ch 3)',
  },
  {
    query: 'how many solutions does a linear equation in two variables have',
    grade: '9',
    subject: 'mathematics',
    note: 'Linear Equations in Two Variables (ch 4)',
  },
  {
    query: 'prove that the diagonals of a parallelogram bisect each other',
    grade: '9',
    subject: 'mathematics',
    note: 'Quadrilaterals (ch 8)',
  },
  {
    query: 'what is the angle subtended by a chord at the centre of a circle',
    grade: '9',
    subject: 'mathematics',
    note: 'Circles (ch 9)',
  },
  {
    query: 'how do i find the area of a triangle when i know all three sides',
    grade: '9',
    subject: 'mathematics',
    note: "Heron's Formula (ch 10)",
  },
  {
    query: 'what is the difference between mean median and mode',
    grade: '9',
    subject: 'mathematics',
    note: 'Statistics (ch 12)',
  },
  {
    query: 'find the volume of a hemisphere of radius r',
    grade: '9',
    subject: 'mathematics',
    note: 'Surface Areas and Volumes (ch 11)',
  },
  // --- Grade 8 --------------------------------------------------------------
  {
    query: 'why do cyclones form and how does air pressure cause wind',
    grade: '8',
    subject: 'science',
    note: 'Pressure, Winds, Storms, and Cyclones (ch 6)',
  },
  {
    query: 'what can i do when i feel stressed before an exam',
    grade: '8',
    subject: 'science',
    note: 'Nurturing Mental Health (ch 3)',
  },
  {
    query: 'how did people keep track of time using the sun and the moon',
    grade: '8',
    subject: 'science',
    note: 'Keeping Time with the Skies (ch 11)',
  },
  {
    query: 'what is a variable and how do i design a fair experiment',
    grade: '8',
    subject: 'science',
    note: 'Exploring the Investigative World of Science (ch 1)',
  },
  {
    query: 'what are the laws of exponents with examples',
    grade: '8',
    subject: 'mathematics',
    note: 'Power Play (ch 2)',
  },
  {
    query: 'how do i find the square root of a number by long division',
    grade: '8',
    subject: 'mathematics',
    note: 'Squares, Square Roots, and Pythagorean Theorem (ch 9)',
  },
  {
    query: 'how do i calculate profit percent and loss percent',
    grade: '8',
    subject: 'mathematics',
    note: 'Percentage and its Applications (ch 8)',
  },
  {
    query: 'what are the properties of a rhombus and a trapezium',
    grade: '8',
    subject: 'mathematics',
    note: 'Quadrilaterals (ch 4)',
  },
  {
    query: 'how do i find the surface area of a cylinder',
    grade: '8',
    subject: 'mathematics',
    note: 'Mensuration (ch 14)',
  },
  // --- Grade 7 --------------------------------------------------------------
  {
    query: 'how is a shadow formed and why is it always dark',
    grade: '7',
    subject: 'science',
    note: 'Light: Shadows and Reflections (ch 11)',
  },
  {
    query: 'why do we see different phases of the moon',
    grade: '7',
    subject: 'science',
    note: 'Earth, Moon, and the Sun (ch 12)',
  },
  {
    query: 'how is cotton fabric made from cotton plants',
    grade: '7',
    subject: 'science',
    note: 'From Fibres to Fabrics (ch 4)',
  },
  {
    query: 'how do i calculate average speed in a race',
    grade: '7',
    subject: 'science',
    note: 'Motion and Sports (ch 8)',
  },
  {
    query: 'how do i add and subtract negative integers',
    grade: '7',
    subject: 'mathematics',
    note: 'Operations with Integers (ch 10)',
  },
  {
    query: 'what is the difference between parallel and intersecting lines',
    grade: '7',
    subject: 'mathematics',
    note: 'Parallel and Intersecting Lines (ch 5)',
  },
  // --- Grade 6 --------------------------------------------------------------
  {
    query: 'how does a thermometer measure temperature',
    grade: '6',
    subject: 'science',
    note: 'Temperature and its Measurement (ch 7)',
  },
  {
    query: 'what happens to water when it freezes and when it boils',
    grade: '6',
    subject: 'science',
    note: 'A Journey through States of Water (ch 8)',
  },
  {
    query: 'how can i separate sand from water at home',
    grade: '6',
    subject: 'science',
    note: 'Methods of Separation in Everyday Life (ch 9)',
  },
  {
    query: 'what are the poles of a magnet and which ones attract',
    grade: '6',
    subject: 'science',
    note: 'Exploring Magnets (ch 4)',
  },
  {
    query: 'how do i find the perimeter and the area of a rectangle',
    grade: '6',
    subject: 'mathematics',
    note: 'Perimeter and Area (ch 6)',
  },
  {
    query: 'what are negative numbers and where do i see them in real life',
    grade: '6',
    subject: 'mathematics',
    note: 'The Other Side of Zero (ch 10)',
  },
];
