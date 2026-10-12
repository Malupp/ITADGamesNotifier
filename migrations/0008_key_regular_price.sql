-- Official undiscounted EUR price from ITAD; GG historical minima are not list prices.
ALTER TABLE key_prices ADD COLUMN regular_cents INTEGER;
