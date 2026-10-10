/// The evaluator's notion of "now" and of local time.
///
/// Obsidian evaluates in the device's local zone (`today()` is local
/// midnight), so the daemon passes [`Clock::system`] and every test passes
/// [`Clock::fixed`] with an explicit IANA zone: a test that read the machine's
/// zone would pass on one desk and fail on another.
#[derive(Clone, Debug)]
pub struct Clock {
    pub now_ms: i64,
    pub zone: jiff::tz::TimeZone,
}

impl Clock {
    pub fn system() -> Self {
        Self {
            now_ms: jiff::Timestamp::now().as_millisecond(),
            zone: jiff::tz::TimeZone::system(),
        }
    }

    /// A clock stopped at `now_ms` in the named zone. Panics on an unknown
    /// zone name or an instant outside jiff's range: either is a
    /// test-authoring error, not an input.
    pub fn fixed(now_ms: i64, zone: &str) -> Self {
        if let Err(error) = jiff::Timestamp::from_millisecond(now_ms) {
            panic!("now_ms {now_ms} is not a representable instant: {error}");
        }
        Self {
            now_ms,
            zone: jiff::tz::TimeZone::get(zone)
                .unwrap_or_else(|error| panic!("unknown time zone {zone:?}: {error}")),
        }
    }

    /// The local date, as the instant of its midnight in this clock's zone:
    /// exactly what `today()` answers, so two clocks agree on it exactly when
    /// `today()` would.
    pub fn local_day(&self) -> i64 {
        crate::dates::start_of_day(self.now_ms, self).epoch_ms
    }
}
