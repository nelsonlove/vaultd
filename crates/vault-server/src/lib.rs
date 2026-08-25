use vault_protocol::{Request, RequestEnvelope, Response, ResponseEnvelope, validate_version};

#[derive(Clone, Debug, Default)]
pub struct Server;

impl Server {
    pub fn handle(&self, request: RequestEnvelope) -> ResponseEnvelope {
        let id = request.id;
        if let Err(error) = validate_version(request.version) {
            return ResponseEnvelope::error(id, error);
        }

        match request.request {
            Request::Health => ResponseEnvelope::success(id, Response::health("vaultd")),
        }
    }
}
