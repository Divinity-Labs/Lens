#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Env, String};

#[contracttype]
enum DataKey {
    Price,
}

#[contract]
pub struct OracleRelayContract;

#[contractimpl]
impl OracleRelayContract {
    pub fn set_price(env: Env, price: String) {
        env.storage().instance().set(&DataKey::Price, &price);
    }

    pub fn get_price(env: Env) -> Option<String> {
        env.storage().instance().get(&DataKey::Price)
    }
}