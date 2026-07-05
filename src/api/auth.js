import { request } from '../services/request';
import { handleConfig } from '../coordinators/userCoordinator';

async function headlessVerify(type, params) {
    if (typeof window === 'undefined' || !window.__VRCX_HEADLESS__) {
        return null;
    }
    const response = await fetch(`/headless/session/2fa/${type}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
    });
    const json = await response.json();
    if (!response.ok) {
        throw new Error(json?.error?.message || response.statusText);
    }
    return {
        json,
        params
    };
}

const loginReq = {
    /**
     * @param {{ code: string }} params One-time password
     * @returns {Promise<{json: any, params: { code: string }}>}
     */
    verifyOTP(params) {
        if (typeof window !== 'undefined' && window.__VRCX_HEADLESS__) {
            return headlessVerify('otp', params);
        }
        return request('auth/twofactorauth/otp/verify', {
            method: 'POST',
            params
        }).then((json) => {
            const args = {
                json,
                params
            };
            return args;
        });
    },

    /**
     * @param {{ code: string }} params One-time token
     * @returns {Promise<{json: any, params: { code: string }}>}
     */
    verifyTOTP(params) {
        if (typeof window !== 'undefined' && window.__VRCX_HEADLESS__) {
            return headlessVerify('totp', params);
        }
        return request('auth/twofactorauth/totp/verify', {
            method: 'POST',
            params
        }).then((json) => {
            const args = {
                json,
                params
            };
            return args;
        });
    },

    /**
     * @param {{ code: string }} params One-time token
     * @returns {Promise<{json: any, params: { code: string }}>}
     */
    verifyEmailOTP(params) {
        if (typeof window !== 'undefined' && window.__VRCX_HEADLESS__) {
            return headlessVerify('emailOtp', params);
        }
        return request('auth/twofactorauth/emailotp/verify', {
            method: 'POST',
            params
        }).then((json) => {
            const args = {
                json,
                params
            };
            return args;
        });
    },

    /**
     * @returns {Promise<{json: any}>}
     */
    getConfig() {
        return request('config', {
            method: 'GET'
        }).then((json) => {
            const args = {
                json
            };
            handleConfig(args);
            return args;
        });
    }
};

export default loginReq;
