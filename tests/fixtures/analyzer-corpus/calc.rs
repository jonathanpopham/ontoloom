//! Tiny fixture repository for the analyze endpoint test. Any analyzer that
//! speaks the Ontoloom hierarchy wire format should be able to map this.

pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

pub fn sub(a: i64, b: i64) -> i64 {
    add(a, -b)
}

pub fn mul(a: i64, b: i64) -> i64 {
    (0..b.abs()).map(|_| a).sum::<i64>() * b.signum()
}

fn main() {
    println!("{} {} {}", add(2, 3), sub(9, 4), mul(6, 7));
}
